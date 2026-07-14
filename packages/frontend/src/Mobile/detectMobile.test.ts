import { describe, expect, it } from "vitest";
import { isMobileDevice } from "./detectMobile";

const mmMatching = (matched: string[]) => (q: string) =>
	({ matches: matched.includes(q) }) as MediaQueryList;

describe("isMobileDevice", () => {
	it("is true when the primary pointer is coarse", () => {
		expect(isMobileDevice(mmMatching(["(pointer: coarse)"]))).toBe(true);
	});

	it("is false when the primary pointer is fine", () => {
		expect(isMobileDevice(mmMatching([]))).toBe(false);
	});

	it("is true when the ?ipod override is in the query string, regardless of pointer", () => {
		expect(isMobileDevice(mmMatching([]), "?ipod")).toBe(true);
		expect(isMobileDevice(mmMatching([]), "?foo=1&ipod")).toBe(true);
	});

	it("ignores unrelated query params", () => {
		expect(isMobileDevice(mmMatching([]), "?ipodcast=1")).toBe(false);
		expect(isMobileDevice(mmMatching([]), "")).toBe(false);
	});
});
