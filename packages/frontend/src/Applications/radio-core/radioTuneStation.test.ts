import { describe, expect, it } from "vitest";
import { radioTuneStation } from "./radioTuneStation";

describe("radioTuneStation", () => {
	it("builds a ClassicyAppRadioScannerTuneStation action carrying the station slug", () => {
		expect(radioTuneStation("wnyc")).toEqual({
			type: "ClassicyAppRadioScannerTuneStation",
			station: "wnyc",
		});
	});
});
