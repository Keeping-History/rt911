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

const CONFIRM_BASE_URL = "https://beta.911realtime.org/?confirm-email=";
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

module.exports = {
	id: "profile",
	handler: (router, context) => {
		const { services, getSchema, env, logger } = context;
		const { UsersService, MailService } = services;

		// Service-level access: ownership/identity checks happen explicitly in
		// each route against req.accountability — never trust the body for "who".
		const admin = { admin: true, role: null };

		async function emailTaken(email) {
			const users = new UsersService({ schema: await getSchema(), accountability: admin });
			const rows = await users.readByQuery({ filter: { email: { _eq: email } }, limit: 1 });
			return rows.length > 0;
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
						`24 hours:\n\n${CONFIRM_BASE_URL}${token}\n\nIf this wasn't you, ignore this message.`,
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
	},
};
