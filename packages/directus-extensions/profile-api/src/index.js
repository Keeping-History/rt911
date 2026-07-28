// profile-api — verified email changes for teacher accounts.
// Spec: plans/2026-07-16-account-profile-design.md (§Email-change extension).
//
// Email is deliberately NOT writable via /users/me (permission field list);
// these two routes are the only path, so every change proves control of the
// new address. The pending state is a stateless HS256 JWT signed with the
// runtime SECRET — no table, nothing to clean up, expiry is enforcement.
//
// JWT via node:crypto rather than a library: extensions resolve modules from
// their own bundle, and vendoring ~30 lines beats depending on the host's
// internal node_modules layout across Directus upgrades.
const crypto = require("node:crypto");

const TOKEN_TTL_SECONDS = 24 * 3600;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const b64url = (input) =>
	Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function sign(payload, secret) {
	const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const body = b64url(JSON.stringify(payload));
	const sig = crypto
		.createHmac("sha256", secret)
		.update(`${header}.${body}`)
		.digest("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	return `${header}.${body}.${sig}`;
}

// Returns the payload object, or null on ANY defect (shape, signature, expiry).
function verify(token, secret) {
	if (typeof token !== "string") return null;
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	const [header, body, sig] = parts;
	const expected = crypto
		.createHmac("sha256", secret)
		.update(`${header}.${body}`)
		.digest("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	const a = Buffer.from(sig);
	const b = Buffer.from(expected);
	if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
	let payload;
	try {
		payload = JSON.parse(Buffer.from(body, "base64url").toString());
	} catch {
		return null;
	}
	if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) return null;
	return payload;
}

const errors = (res, status, message) => res.status(status).json({ errors: [{ message }] });

// Collections whose rows belong to one user and go with them. Every one of
// these is keyed by `user_created`; chat_messages is handled separately
// because it is written by the Go streamer, not Directus, and keys on "user".
const OWNED_COLLECTIONS = ["playlists", "stacks", "tm_bookmarks_personal"];

// Profile fields blanked by a data wipe. `email` is absent deliberately — it
// is the login identity, and the account survives a data wipe.
const PROFILE_FIELDS = [
	"first_name", "last_name", "username", "city", "state", "country",
	"school_name", "educator_role", "grade_levels", "subjects",
	"avatar", "filesystem",
];

// Foreign keys onto directus_users declared ON DELETE NO ACTION. Postgres
// REJECTS the user delete while any of them still points at the row — this is
// not a data-loss risk, it is a hard failure, and it fires for every account
// that has ever uploaded an avatar. Nulling them is idempotent, so a retried
// deletion is safe. tm_bookmarks_personal is the sixth such FK and resolves
// itself: eraseOwnedData deletes those rows outright, which is why data
// erasure must run BEFORE the row delete rather than after.
const BLOCKING_REFS = [
	["directus_files", "uploaded_by"],
	["directus_files", "modified_by"],
	["directus_notifications", "sender"],
	["directus_versions", "user_updated"],
	["directus_comments", "user_updated"],
];

module.exports = {
	id: "profile",
	handler: (router, context) => {
		const { services, getSchema, env, logger, database } = context;
		const { ItemsService, UsersService, MailService } = services;

		// Service-level access: ownership/identity checks happen explicitly in
		// each route against req.accountability — never trust the body for "who".
		const admin = { admin: true, role: null };

		// The desktop app's own origin, NOT Directus's PUBLIC_URL — that one
		// holds the API's URL (api.911realtime.org), and mailing a confirmation
		// link there would send people into the REST API instead of the app.
		const confirmBaseUrl = `${env.RT911_APP_URL || "https://911realtime.org"}/?confirm-email=`;

		async function emailTaken(email) {
			const users = new UsersService({ schema: await getSchema(), accountability: admin });
			const rows = await users.readByQuery({ filter: { email: { _eq: email } }, limit: 1 });
			return rows.length > 0;
		}

		// Deletes everything this user owns, EXCEPT their directus_files (kept
		// by product requirement) and their chat_blocks (moderation standing
		// must outlive a data wipe, or a blocked student clears their own
		// cool-down and the supporting evidence in one click).
		//
		// Each group is wrapped independently rather than aborting on the first
		// error: someone who asked to be forgotten should have as much removed
		// as possible, and the caller reports what remains.
		async function eraseOwnedData(userId, schema) {
			const deleted = {};
			const failed = [];

			for (const collection of OWNED_COLLECTIONS) {
				try {
					const items = new ItemsService(collection, { schema, accountability: admin });
					const rows = await items.readByQuery({
						filter: { user_created: { _eq: userId } },
						fields: ["id"],
						limit: -1,
					});
					if (rows.length > 0) await items.deleteMany(rows.map((r) => r.id));
					deleted[collection] = rows.length;
				} catch (err) {
					logger.error(err, `profile-api: could not erase ${collection} for ${userId}`);
					failed.push(collection);
				}
			}

			try {
				// Query builder, not raw SQL: knex quotes identifiers, and "user"
				// is a reserved word that resolves to CURRENT_USER unquoted --
				// matching the wrong rows without erroring.
				deleted.chat_messages = await database("chat_messages").where("user", userId).del();
			} catch (err) {
				logger.error(err, `profile-api: could not erase chat_messages for ${userId}`);
				failed.push("chat_messages");
			}

			return { deleted, failed };
		}

		// Nulls every profile field, leaving the account signed-in-able.
		async function blankProfile(userId, schema) {
			const patch = {};
			for (const field of PROFILE_FIELDS) patch[field] = null;
			const users = new UsersService({ schema, accountability: admin });
			await users.updateOne(userId, patch);
		}

		router.post("/email-change", async (req, res) => {
			try {
				const userId = req.accountability && req.accountability.user;
				if (!userId) return errors(res, 401, "You must be signed in.");
				const raw = req.body && req.body.newEmail;
				const newEmail = typeof raw === "string" ? raw.trim().toLowerCase() : "";
				if (!EMAIL_RE.test(newEmail)) return errors(res, 400, "Please enter a valid email address.");
				if (await emailTaken(newEmail)) return errors(res, 400, "That email address is already in use.");

				const iat = Math.floor(Date.now() / 1000);
				const token = sign(
					{ sub: userId, email: newEmail, scope: "email-change", iat, exp: iat + TOKEN_TTL_SECONDS },
					env.SECRET,
				);
				const mail = new MailService({ schema: await getSchema(), accountability: null });
				await mail.send({
					to: newEmail,
					subject: "Confirm your new email — 911realtime.org",
					text:
						"A change of the email address on your 911realtime.org teacher account " +
						"was requested. If this was you, confirm it by opening this link within " +
						`24 hours:\n\n${confirmBaseUrl}${token}\n\nIf this wasn't you, ignore this message.`,
				});
				logger.info(`profile-api: email-change link sent for user ${userId}`);
				return res.sendStatus(204);
			} catch (err) {
				logger.error(err, "profile-api: email-change request failed");
				return errors(res, 500, "Could not send the confirmation email.");
			}
		});

		router.post("/email-change/confirm", async (req, res) => {
			try {
				const userId = req.accountability && req.accountability.user;
				if (!userId) return errors(res, 401, "You must be signed in.");
				const payload = verify(req.body && req.body.token, env.SECRET);
				if (!payload || payload.scope !== "email-change") {
					return errors(res, 400, "This confirmation link is invalid or has expired.");
				}
				if (payload.sub !== userId) {
					return errors(res, 403, "This confirmation link belongs to a different account.");
				}
				if (await emailTaken(payload.email)) {
					return errors(res, 400, "That email address is already in use.");
				}
				const users = new UsersService({ schema: await getSchema(), accountability: admin });
				await users.updateOne(payload.sub, { email: payload.email });
				logger.info(`profile-api: email changed for user ${userId}`);
				return res.status(200).json({ data: { email: payload.email } });
			} catch (err) {
				logger.error(err, "profile-api: email-change confirm failed");
				return errors(res, 500, "Could not apply the email change.");
			}
		});

		router.post("/delete-data", async (req, res) => {
			try {
				const userId = req.accountability && req.accountability.user;
				if (!userId) return errors(res, 401, "You must be signed in.");
				const schema = await getSchema();
				const result = await eraseOwnedData(userId, schema);
				try {
					await blankProfile(userId, schema);
					result.deleted.profile = 1;
				} catch (err) {
					logger.error(err, `profile-api: could not blank profile for ${userId}`);
					result.failed.push("profile");
				}
				logger.info(`profile-api: data erased for user ${userId}`);
				return res.status(200).json({ data: result });
			} catch (err) {
				logger.error(err, "profile-api: delete-data failed");
				return errors(res, 500, "Could not delete your data.");
			}
		});

		router.post("/delete-account", async (req, res) => {
			try {
				const userId = req.accountability && req.accountability.user;
				if (!userId) return errors(res, 401, "You must be signed in.");
				const schema = await getSchema();

				const result = await eraseOwnedData(userId, schema);
				try {
					await blankProfile(userId, schema);
				} catch (err) {
					// Not fatal: the row is about to be deleted anyway. Logged so a
					// partial failure is still visible if the delete then fails too
					// and the account survives scrubbed.
					logger.error(err, `profile-api: could not blank profile for ${userId}`);
				}

				// Must happen before deleteOne -- see BLOCKING_REFS.
				for (const [table, column] of BLOCKING_REFS) {
					await database(table).where(column, userId).update({ [column]: null });
				}

				const users = new UsersService({ schema, accountability: admin });
				await users.deleteOne(userId);

				result.deleted.account = 1;
				logger.info(`profile-api: account deleted for user ${userId}`);
				return res.status(200).json({ data: result });
			} catch (err) {
				logger.error(err, "profile-api: delete-account failed");
				return errors(res, 500, "Could not delete your account.");
			}
		});
	},
};
