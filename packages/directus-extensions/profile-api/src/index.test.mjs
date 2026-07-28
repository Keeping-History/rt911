// Unit tests for the profile-api endpoint extension. The extension's handler
// registers routes on an express-style router; we capture them with a stub and
// invoke them with fake req/res, mocking Directus's context services.
import { describe, it, expect, vi } from "vitest";
import extension from "./index.js";
import crypto from "node:crypto";

const SECRET = "test-secret-0123456789abcdef0123";

// Minimal HS256 JWT helpers for crafting expired/tampered tokens in tests.
const b64url = (buf) =>
	Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function makeJwt(payload, secret = SECRET) {
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
const nowSec = () => Math.floor(Date.now() / 1000);

function makeHarness({
	existingEmails = [],
	// Rows each owned collection reports for the user, keyed by collection.
	ownedRows = {},
	// Collections whose ItemsService should throw, to exercise partial failure.
	failCollections = [],
	// When true, deleting the directus_users row throws (the FK-violation case).
	failUserDelete = false,
} = {}) {
	const routes = {};
	const router = {
		post: (path, fn) => {
			routes[path] = fn;
		},
	};
	const sent = [];
	const updated = [];
	// Every mutation in call order, so tests can assert ORDERING and not just
	// occurrence -- nulling the blocking FKs after deleteOne would be useless.
	const ops = [];
	class UsersService {
		async readByQuery(q) {
			const email = q?.filter?.email?._eq;
			return existingEmails.includes(email) ? [{ id: "someone" }] : [];
		}
		async updateOne(id, patch) {
			updated.push({ id, patch });
			ops.push({ op: "updateUser", id });
			return id;
		}
		async deleteOne(id) {
			if (failUserDelete) throw new Error("update or delete on table violates foreign key constraint");
			ops.push({ op: "deleteUser", id });
			return id;
		}
	}
	class ItemsService {
		constructor(collection) {
			this.collection = collection;
		}
		async readByQuery() {
			if (failCollections.includes(this.collection)) throw new Error("boom");
			return ownedRows[this.collection] ?? [];
		}
		async deleteMany(ids) {
			ops.push({ op: "deleteItems", collection: this.collection, ids });
			return ids;
		}
	}
	class MailService {
		async send(msg) {
			sent.push(msg);
		}
	}
	// Minimal knex stand-in: database(table).where(col, val).del() / .update(patch)
	const database = (table) => ({
		_col: undefined,
		where(col, val) {
			this._col = col;
			this._val = val;
			return this;
		},
		async del() {
			ops.push({ op: "del", table, col: this._col, val: this._val });
			return (ownedRows[table] ?? []).length;
		},
		async update(patch) {
			ops.push({ op: "nullRef", table, col: this._col, patch });
			return 1;
		},
	});
	const context = {
		services: { UsersService, ItemsService, MailService },
		env: { SECRET },
		database,
		getSchema: async () => ({}),
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	};
	extension.handler(router, context);
	const call = async (path, { user = "user-1", body = {} } = {}) => {
		const res = {
			statusCode: 200,
			body: undefined,
			status(c) {
				this.statusCode = c;
				return this;
			},
			json(b) {
				this.body = b;
				return this;
			},
			sendStatus(c) {
				this.statusCode = c;
				return this;
			},
		};
		const req = { accountability: user ? { user } : null, body };
		await routes[path](req, res);
		return res;
	};
	return { call, sent, updated, ops };
}

describe("POST /email-change", () => {
	it("401s unauthenticated", async () => {
		const h = makeHarness();
		const res = await h.call("/email-change", { user: null, body: { newEmail: "a@b.co" } });
		expect(res.statusCode).toBe(401);
	});
	it("400s an invalid email", async () => {
		const h = makeHarness();
		const res = await h.call("/email-change", { body: { newEmail: "not-an-email" } });
		expect(res.statusCode).toBe(400);
		expect(h.sent).toHaveLength(0);
	});
	it("400s an email already in use", async () => {
		const h = makeHarness({ existingEmails: ["taken@example.com"] });
		const res = await h.call("/email-change", { body: { newEmail: "Taken@Example.com" } });
		expect(res.statusCode).toBe(400);
		expect(res.body.errors[0].message).toBe("That email address is already in use.");
	});
	it("sends a confirmation link carrying a valid scoped JWT and responds 204", async () => {
		const h = makeHarness();
		const res = await h.call("/email-change", { body: { newEmail: "New@Example.com" } });
		expect(res.statusCode).toBe(204);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0].to).toBe("new@example.com");
		const token = h.sent[0].text.match(/confirm-email=([\w.-]+)/)[1];
		const [header, payload, sig] = token.split(".");
		const expectSig = crypto
			.createHmac("sha256", SECRET)
			.update(`${header}.${payload}`)
			.digest("base64")
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		expect(sig).toBe(expectSig);
		const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
		expect(decoded).toMatchObject({ sub: "user-1", email: "new@example.com", scope: "email-change" });
		expect(decoded.exp - decoded.iat).toBe(24 * 3600);
	});
});

describe("POST /email-change/confirm", () => {
	const valid = (over = {}) =>
		makeJwt({
			sub: "user-1",
			email: "new@example.com",
			scope: "email-change",
			iat: nowSec(),
			exp: nowSec() + 3600,
			...over,
		});

	it("401s unauthenticated", async () => {
		const h = makeHarness();
		const res = await h.call("/email-change/confirm", { user: null, body: { token: valid() } });
		expect(res.statusCode).toBe(401);
	});
	it("applies the change on a valid token", async () => {
		const h = makeHarness();
		const res = await h.call("/email-change/confirm", { body: { token: valid() } });
		expect(res.statusCode).toBe(200);
		expect(res.body).toEqual({ data: { email: "new@example.com" } });
		expect(h.updated).toEqual([{ id: "user-1", patch: { email: "new@example.com" } }]);
	});
	it("400s an expired token", async () => {
		const h = makeHarness();
		const res = await h.call("/email-change/confirm", {
			body: { token: valid({ iat: nowSec() - 7200, exp: nowSec() - 3600 }) },
		});
		expect(res.statusCode).toBe(400);
		expect(res.body.errors[0].message).toBe("This confirmation link is invalid or has expired.");
	});
	it("400s a tampered token", async () => {
		const h = makeHarness();
		const res = await h.call("/email-change/confirm", {
			body: { token: makeJwt({ sub: "user-1", email: "evil@x.co", scope: "email-change", iat: nowSec(), exp: nowSec() + 60 }, "wrong-secret") },
		});
		expect(res.statusCode).toBe(400);
	});
	it("403s a token for a different user", async () => {
		const h = makeHarness();
		const res = await h.call("/email-change/confirm", {
			user: "user-2",
			body: { token: valid() },
		});
		expect(res.statusCode).toBe(403);
		expect(res.body.errors[0].message).toBe("This confirmation link belongs to a different account.");
	});
	it("400s when the email was taken since the link was sent", async () => {
		const h = makeHarness({ existingEmails: ["new@example.com"] });
		const res = await h.call("/email-change/confirm", { body: { token: valid() } });
		expect(res.statusCode).toBe(400);
		expect(res.body.errors[0].message).toBe("That email address is already in use.");
		expect(h.updated).toHaveLength(0);
	});
});

// Rows a fully-populated account owns, used across the deletion suites.
const POPULATED = {
	playlists: [{ id: "p1" }, { id: "p2" }],
	stacks: [{ id: 7 }],
	tm_bookmarks_personal: [{ id: "b1" }],
	chat_messages: [{ id: 1 }, { id: 2 }, { id: 3 }],
};

describe("POST /delete-data", () => {
	it("401s unauthenticated", async () => {
		const h = makeHarness();
		const res = await h.call("/delete-data", { user: null });
		expect(res.statusCode).toBe(401);
		expect(h.ops).toHaveLength(0);
	});

	it("deletes every owned collection and the chat history", async () => {
		const h = makeHarness({ ownedRows: POPULATED });
		const res = await h.call("/delete-data");
		expect(res.statusCode).toBe(200);
		expect(res.body.data.failed).toEqual([]);
		expect(res.body.data.deleted).toMatchObject({
			playlists: 2,
			stacks: 1,
			tm_bookmarks_personal: 1,
			chat_messages: 3,
			profile: 1,
		});
		const collections = h.ops.filter((o) => o.op === "deleteItems").map((o) => o.collection);
		expect(collections).toEqual(["playlists", "stacks", "tm_bookmarks_personal"]);
	});

	it("deletes chat_messages by the quoted user column", async () => {
		// "user" is a Postgres reserved word: unquoted it resolves to
		// CURRENT_USER and silently matches the wrong rows. Going through the
		// knex query builder is what keeps it quoted.
		const h = makeHarness({ ownedRows: POPULATED });
		await h.call("/delete-data", { user: "user-9" });
		expect(h.ops).toContainEqual({
			op: "del",
			table: "chat_messages",
			col: "user",
			val: "user-9",
		});
	});

	it("never touches chat_blocks or directus_files", async () => {
		// Moderation standing must outlive a data wipe, and uploaded files are
		// kept by product requirement.
		const h = makeHarness({ ownedRows: POPULATED });
		await h.call("/delete-data");
		const tables = h.ops.map((o) => o.table ?? o.collection);
		expect(tables).not.toContain("chat_blocks");
		expect(tables).not.toContain("directus_files");
	});

	it("blanks the profile but keeps the account", async () => {
		const h = makeHarness({ ownedRows: POPULATED });
		await h.call("/delete-data");
		expect(h.updated).toHaveLength(1);
		const { patch } = h.updated[0];
		expect(patch.first_name).toBeNull();
		expect(patch.username).toBeNull();
		expect(patch.avatar).toBeNull();
		expect(patch.filesystem).toBeNull();
		// Email is the login identity and the account survives a data wipe.
		expect(patch).not.toHaveProperty("email");
		expect(h.ops.some((o) => o.op === "deleteUser")).toBe(false);
	});

	it("reports a failed collection instead of aborting the rest", async () => {
		const h = makeHarness({ ownedRows: POPULATED, failCollections: ["stacks"] });
		const res = await h.call("/delete-data");
		expect(res.statusCode).toBe(200);
		expect(res.body.data.failed).toEqual(["stacks"]);
		// The later collections still ran.
		expect(res.body.data.deleted.tm_bookmarks_personal).toBe(1);
		expect(res.body.data.deleted.chat_messages).toBe(3);
	});
});

describe("POST /delete-account", () => {
	it("401s unauthenticated", async () => {
		const h = makeHarness();
		const res = await h.call("/delete-account", { user: null });
		expect(res.statusCode).toBe(401);
		expect(h.ops).toHaveLength(0);
	});

	it("deletes the user row and reports it", async () => {
		const h = makeHarness({ ownedRows: POPULATED });
		const res = await h.call("/delete-account", { user: "user-9" });
		expect(res.statusCode).toBe(200);
		expect(res.body.data.deleted.account).toBe(1);
		expect(h.ops).toContainEqual({ op: "deleteUser", id: "user-9" });
	});

	it("nulls every blocking foreign key BEFORE deleting the row", async () => {
		// This is the whole ballgame. directus_files.uploaded_by is ON DELETE
		// NO ACTION, so Postgres rejects the delete while it still points at
		// the user -- which is every account that ever uploaded an avatar.
		// Nulling them after the delete would be useless, hence the ordering
		// assertion rather than a bare "did it happen".
		const h = makeHarness({ ownedRows: POPULATED });
		await h.call("/delete-account", { user: "user-9" });

		const nulled = h.ops.filter((o) => o.op === "nullRef");
		expect(nulled.map((o) => `${o.table}.${o.col}`)).toEqual([
			"directus_files.uploaded_by",
			"directus_files.modified_by",
			"directus_notifications.sender",
			"directus_versions.user_updated",
			"directus_comments.user_updated",
		]);
		for (const ref of nulled) expect(ref.patch[ref.col]).toBeNull();

		const lastNull = h.ops.findLastIndex((o) => o.op === "nullRef");
		const userDelete = h.ops.findIndex((o) => o.op === "deleteUser");
		expect(lastNull).toBeLessThan(userDelete);
	});

	it("erases owned data before deleting the row", async () => {
		// tm_bookmarks_personal.user_created is a sixth NO ACTION FK; it is
		// resolved by deleting those rows, which only works in this order.
		const h = makeHarness({ ownedRows: POPULATED });
		await h.call("/delete-account");
		const lastItemDelete = h.ops.findLastIndex((o) => o.op === "deleteItems");
		const userDelete = h.ops.findIndex((o) => o.op === "deleteUser");
		expect(lastItemDelete).toBeLessThan(userDelete);
	});

	it("keeps chat_blocks so the moderation record outlives the account", async () => {
		const h = makeHarness({ ownedRows: POPULATED });
		await h.call("/delete-account");
		expect(h.ops.map((o) => o.table)).not.toContain("chat_blocks");
	});

	it("500s when the row cannot be deleted, without claiming success", async () => {
		// The client keys off this: on a 500 it must NOT clear local settings
		// or reload, because the account still exists.
		const h = makeHarness({ ownedRows: POPULATED, failUserDelete: true });
		const res = await h.call("/delete-account");
		expect(res.statusCode).toBe(500);
		expect(res.body.errors[0].message).toBe("Could not delete your account.");
		expect(h.ops.some((o) => o.op === "deleteUser")).toBe(false);
	});
});
