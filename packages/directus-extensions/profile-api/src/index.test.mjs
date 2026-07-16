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

function makeHarness({ existingEmails = [] } = {}) {
	const routes = {};
	const router = {
		post: (path, fn) => {
			routes[path] = fn;
		},
	};
	const sent = [];
	const updated = [];
	class UsersService {
		async readByQuery(q) {
			const email = q?.filter?.email?._eq;
			return existingEmails.includes(email) ? [{ id: "someone" }] : [];
		}
		async updateOne(id, patch) {
			updated.push({ id, patch });
			return id;
		}
	}
	class MailService {
		async send(msg) {
			sent.push(msg);
		}
	}
	const context = {
		services: { UsersService, MailService },
		env: { SECRET },
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
	return { call, sent, updated };
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
