import { describe, expect, it } from "vitest";
import { resolveItemId, resolveItemIds } from "./useDirectusItem";

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

describe("resolveItemIds", () => {
	it("resolves every entry of an array option, each through the expression engine", () => {
		expect(resolveItemIds([1, "clip", 3], "", (e) => (e === "clip" ? "2" : e))).toEqual(["1", "2", "3"]);
	});

	it("wraps a single legacy scalar option into a one-entry list", () => {
		expect(resolveItemIds(42, "", identity)).toEqual(["42"]);
	});

	it("drops non-string/number array entries and entries that resolve empty", () => {
		expect(resolveItemIds([1, null, "", 2], "", identity)).toEqual(["1", "2"]);
	});

	it("falls back to the field value as a single-entry list when the option is empty", () => {
		expect(resolveItemIds(undefined, "7", identity)).toEqual(["7"]);
		expect(resolveItemIds([], "7", identity)).toEqual(["7"]);
	});

	it("is an empty list when nothing usable is set", () => {
		expect(resolveItemIds(undefined, "", identity)).toEqual([]);
		expect(resolveItemIds([], "", identity)).toEqual([]);
	});

	it("prefers the option array over the field value even when non-empty", () => {
		expect(resolveItemIds([3], "9", identity)).toEqual(["3"]);
	});
});
