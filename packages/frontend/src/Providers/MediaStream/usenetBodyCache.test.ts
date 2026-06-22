import { describe, expect, it } from "vitest";
import { applyUsenetBodyFrame, emptyUsenetBodyState } from "./usenetBodyCache";

describe("applyUsenetBodyFrame", () => {
	it("stores a body under its id", () => {
		const next = applyUsenetBodyFrame(emptyUsenetBodyState, { id: 7001, body: "Hi.\n" });
		expect(next.bodies[7001]).toBe("Hi.\n");
		expect(next.errors[7001]).toBeUndefined();
	});

	it("stores an empty body (genuinely empty message) without erroring", () => {
		const next = applyUsenetBodyFrame(emptyUsenetBodyState, { id: 7001, body: "" });
		expect(next.bodies[7001]).toBe("");
		expect(next.errors[7001]).toBeUndefined();
	});

	it("stores a failure message as an error", () => {
		const next = applyUsenetBodyFrame(emptyUsenetBodyState, {
			id: 7002,
			message: "message unavailable",
		});
		expect(next.errors[7002]).toBe("message unavailable");
		expect(next.bodies[7002]).toBeUndefined();
	});

	it("does not mutate the input state", () => {
		const start = emptyUsenetBodyState;
		applyUsenetBodyFrame(start, { id: 7001, body: "Hi." });
		expect(start.bodies[7001]).toBeUndefined();
	});

	it("a later success clears a prior error for the same id", () => {
		const errored = applyUsenetBodyFrame(emptyUsenetBodyState, {
			id: 7003,
			message: "message unavailable",
		});
		const fixed = applyUsenetBodyFrame(errored, { id: 7003, body: "recovered" });
		expect(fixed.bodies[7003]).toBe("recovered");
		expect(fixed.errors[7003]).toBeUndefined();
	});
});
