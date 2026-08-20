import { describe, expect, it, vi } from "vitest";
import { AuthRequiredError } from "./authApi";
import {
	assertValidStackDefinition,
	createStack,
	deleteStack,
	getStack,
	listMyStacks,
	updateStack,
} from "./stackApi";

const VALID_DEF = { name: "My Stack", cards: [{ id: "c1" }] };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function okFetch(data: unknown): any {
	return vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200 }));
}

describe("stackApi", () => {
	it("listMyStacks hits items/stacks with own-only fields and returns rows", async () => {
		const rows = [{ id: 1, name: "A", date_updated: null, user_created: "u1" }];
		const fetchFn = okFetch(rows);
		await expect(listMyStacks(fetchFn)).resolves.toEqual(rows);
		const url = String(fetchFn.mock.calls[0]?.[0]);
		expect(url).toContain("/items/stacks?fields=id,name,date_updated,user_created");
		expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({ credentials: "include" });
	});

	it("createStack validates the definition and POSTs name+definition", async () => {
		const fetchFn = okFetch({ id: 2, name: "My Stack", definition: VALID_DEF });
		await createStack("My Stack", VALID_DEF, fetchFn);
		const [, init] = fetchFn.mock.calls[0] ?? [];
		expect(init).toMatchObject({ method: "POST", credentials: "include" });
		expect(JSON.parse(String(init?.body))).toEqual({ name: "My Stack", definition: VALID_DEF });
		await expect(createStack("Bad", { name: "", cards: [] }, fetchFn)).rejects.toThrow(/non-empty/);
	});

	it("updateStack PATCHes only the given keys; deleteStack DELETEs", async () => {
		const fetchFn = okFetch({ id: 3, name: "N", definition: VALID_DEF });
		await updateStack(3, { definition: VALID_DEF }, fetchFn);
		expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({ method: "PATCH" });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const del: any = vi.fn(async () => new Response(null, { status: 204 }));
		await expect(deleteStack(3, del)).resolves.toBeUndefined();
	});

	it("maps 401 to AuthRequiredError with the server message", async () => {
		const fetchFn = vi.fn(async () =>
			new Response(JSON.stringify({ errors: [{ message: "expired" }] }), { status: 401 }),
		);
		await expect(getStack(9, fetchFn)).rejects.toBeInstanceOf(AuthRequiredError);
	});

	it("assertValidStackDefinition surfaces the first validator error", () => {
		expect(() => assertValidStackDefinition({ cards: [] })).toThrow();
		expect(() => assertValidStackDefinition(VALID_DEF)).not.toThrow();
	});
});
