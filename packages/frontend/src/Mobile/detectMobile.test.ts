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
});
