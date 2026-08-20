import { beforeEach, describe, expect, it, vi } from "vitest";

const mockTrackVirtualTimeSet = vi.hoisted(() => vi.fn());
vi.mock("../../openreplay", () => ({
	trackVirtualTimeSet: mockTrackVirtualTimeSet,
}));

import { trackAck } from "./ackTracking";

describe("trackAck", () => {
	beforeEach(() => mockTrackVirtualTimeSet.mockClear());

	it("calls trackVirtualTimeSet with 'init' for init_ack", () => {
		trackAck("init_ack", "2001-09-11T12:46:00Z");
		expect(mockTrackVirtualTimeSet).toHaveBeenCalledWith(
			"2001-09-11T12:46:00Z",
			"init",
		);
	});

	it("calls trackVirtualTimeSet with 'seek' for seek_ack", () => {
		trackAck("seek_ack", "2001-09-11T13:00:00Z");
		expect(mockTrackVirtualTimeSet).toHaveBeenCalledWith(
			"2001-09-11T13:00:00Z",
			"seek",
		);
	});

	it("does nothing for items frames", () => {
		trackAck("items", "2001-09-11T12:46:00Z");
		expect(mockTrackVirtualTimeSet).not.toHaveBeenCalled();
	});

	it("does nothing when time is absent", () => {
		trackAck("init_ack", undefined);
		expect(mockTrackVirtualTimeSet).not.toHaveBeenCalled();
	});
});
