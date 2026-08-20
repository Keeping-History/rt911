import { describe, expect, it } from "vitest";
import { resolveItemId } from "./useDirectusItem";

const identity = (e: string) => e;

describe("resolveItemId", () => {
	it("uses the option id when set", () => {
		expect(resolveItemId(42, "", identity)).toBe("42");
	});
	it("falls back to the field value", () => {
		expect(resolveItemId(undefined, "7", identity)).toBe("7");
	});
	it("prefers the option id over the field value", () => {
		expect(resolveItemId(3, "9", identity)).toBe("3");
	});
	it("resolves through the expression engine", () => {
		expect(resolveItemId("clip", "", (e) => (e === "clip" ? "5" : e))).toBe("5");
	});
	it("is undefined when nothing usable is set", () => {
		expect(resolveItemId(undefined, "", identity)).toBeUndefined();
		expect(resolveItemId("", "", identity)).toBeUndefined();
	});
});
