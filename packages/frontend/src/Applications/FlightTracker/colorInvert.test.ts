import { describe, expect, it } from "vitest";
import { invertHex } from "./colorInvert";

describe("invertHex", () => {
	it("inverts each channel of a #rrggbb color", () => {
		expect(invertHex("#000000")).toBe("#ffffff");
		expect(invertHex("#ffffff")).toBe("#000000");
		// classic light basemap background #efe9dd -> #101622
		expect(invertHex("#efe9dd")).toBe("#101622");
	});
	it("zero-pads channels that invert to a single hex digit", () => {
		expect(invertHex("#f0f0f0")).toBe("#0f0f0f");
	});
	it("is case-insensitive and trims", () => {
		expect(invertHex("  #EFE9DD ")).toBe("#101622");
	});
	it("returns non-#rrggbb input unchanged (defensive)", () => {
		expect(invertHex("rgb(1,2,3)")).toBe("rgb(1,2,3)");
		expect(invertHex("#fff")).toBe("#fff");
	});
});
