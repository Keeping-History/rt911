import { describe, expect, it, vi } from "vitest";
import { AuthRequiredError, ForbiddenError } from "./authApi";
import {
	confirmEmailChange,
	requestEmailChange,
	updateProfile,
} from "./profileApi";

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status });

const mockFetch = (...responses: Response[]) => {
	let i = 0;
	return vi.fn(async (...args: Parameters<typeof fetch>) => {
		void args;
		return responses[Math.min(i++, responses.length - 1)];
	});
};

describe("updateProfile", () => {
	it("PATCHes /users/me with credentials and returns the updated user", async () => {
		const f = vi.fn(async (...args: Parameters<typeof fetch>) => {
			expect(String(args[0])).toContain("/users/me");
			const init = args[1] as RequestInit;
			expect(init.method).toBe("PATCH");
			expect(init.credentials).toBe("include");
			expect(JSON.parse(String(init.body))).toEqual({ first_name: "R", city: "Memphis" });
			return jsonResponse({ data: { id: "u1", first_name: "R", city: "Memphis" } });
		});
		const user = await updateProfile({ first_name: "R", city: "Memphis" }, f);
		expect(user.first_name).toBe("R");
	});
	it("rejects an email key locally without fetching (verified flow only)", async () => {
		const f = vi.fn(async () => jsonResponse({ data: {} }));
		await expect(
			updateProfile({ email: "x@y.z" } as unknown as Parameters<typeof updateProfile>[0], f),
		).rejects.toThrow(/email/i);
		expect(f).not.toHaveBeenCalled();
	});
	it("maps 401/403 to the shared error classes", async () => {
		await expect(updateProfile({ city: "A" }, mockFetch(jsonResponse({}, 401)))).rejects.toBeInstanceOf(AuthRequiredError);
		await expect(updateProfile({ city: "A" }, mockFetch(jsonResponse({}, 403)))).rejects.toBeInstanceOf(ForbiddenError);
	});
	it("allows clearing optional fields with null", async () => {
		const f = vi.fn(async (...args: Parameters<typeof fetch>) => {
			expect(JSON.parse(String((args[1] as RequestInit).body))).toEqual({ city: null });
			return jsonResponse({ data: { id: "u1", city: null } });
		});
		await updateProfile({ city: null }, f);
		expect(f).toHaveBeenCalledTimes(1);
	});
});

describe("requestEmailChange", () => {
	it("POSTs the new email to the extension route", async () => {
		const f = vi.fn(async (...args: Parameters<typeof fetch>) => {
			expect(String(args[0])).toContain("/profile/email-change");
			const init = args[1] as RequestInit;
			expect(init.credentials).toBe("include");
			expect(JSON.parse(String(init.body))).toEqual({ newEmail: "new@x.org" });
			return new Response(null, { status: 204 });
		});
		await expect(requestEmailChange("new@x.org", f)).resolves.toBeUndefined();
	});
	it("throws the server's message on failure", async () => {
		const f = mockFetch(jsonResponse({ errors: [{ message: "That email address is already in use." }] }, 400));
		await expect(requestEmailChange("t@x.org", f)).rejects.toThrow("That email address is already in use.");
	});
});

describe("confirmEmailChange", () => {
	it("POSTs the token and returns the new email", async () => {
		const f = vi.fn(async (...args: Parameters<typeof fetch>) => {
			expect(String(args[0])).toContain("/profile/email-change/confirm");
			expect(JSON.parse(String((args[1] as RequestInit).body))).toEqual({ token: "tok" });
			return jsonResponse({ data: { email: "new@x.org" } });
		});
		expect(await confirmEmailChange("tok", f)).toBe("new@x.org");
	});
	it("maps 403 (wrong account) to ForbiddenError", async () => {
		const f = mockFetch(jsonResponse({ errors: [{ message: "wrong account" }] }, 403));
		await expect(confirmEmailChange("tok", f)).rejects.toBeInstanceOf(ForbiddenError);
	});
});
