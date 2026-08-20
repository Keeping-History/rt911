import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockEvent = vi.fn();
const mockStart = vi.fn();
const mockGetSessionURL = vi.fn();
const mockGetSessionID = vi.fn();
const mockSetUserID = vi.fn();
const mockSetMetadata = vi.fn();

vi.mock("@openreplay/tracker", () => ({
	default: vi.fn(function () {
		return {
			event: mockEvent,
			start: mockStart,
			getSessionURL: mockGetSessionURL,
			getSessionID:  mockGetSessionID,
			setUserID: mockSetUserID,
			setMetadata: mockSetMetadata,
		};
	}),
}));

import {
	getSessionID,
	getSessionURL,
	identifyUser,
	initTracker,
	trackAppToggle,
	trackChannelChange,
	trackPauseResume,
	trackVirtualTimeSet,
} from "./openreplay";

describe("openreplay", () => {
	describe("before initTracker is called", () => {
		it("event helpers do not throw when tracker is uninitialised", () => {
			expect(() =>
				trackVirtualTimeSet("2001-09-11T12:46:00Z", "seek"),
			).not.toThrow();
			expect(() => trackChannelChange("CNN", "ABC")).not.toThrow();
			expect(() => trackAppToggle("TV.app", "open")).not.toThrow();
			expect(() =>
				trackPauseResume("pause", "2001-09-11T12:46:00Z"),
			).not.toThrow();
		});

		it("getSessionURL returns undefined when tracker is uninitialised", () => {
			expect(getSessionURL()).toBeUndefined();
		});

		it("getSessionID returns undefined when tracker is uninitialised", () => {
			expect(getSessionID()).toBeUndefined();
		});

		it("identifyUser does not throw when tracker is uninitialised", () => {
			expect(() =>
				identifyUser({ id: "u-1", email: "jane@example.com" }),
			).not.toThrow();
			expect(mockSetUserID).not.toHaveBeenCalled();
		});
	});

	describe("after initTracker with project key", () => {
		beforeAll(() => {
			vi.stubEnv("VITE_OPENREPLAY_PROJECT_KEY", "test-key");
			vi.stubEnv(
				"VITE_OPENREPLAY_INGEST_URL",
				"https://or.test/ingest",
			);
			initTracker();
		});

		beforeEach(() => {
			mockEvent.mockClear();
			mockStart.mockClear();
		});

		it("creates tracker with projectKey and ingestPoint", async () => {
			initTracker();
			const { default: MockTracker } = await import(
				"@openreplay/tracker"
			);
			expect(MockTracker).toHaveBeenCalledWith({
				projectKey: "test-key",
				ingestPoint: "https://or.test/ingest",
			});
			expect(mockStart).toHaveBeenCalledTimes(1);
		});

		it("trackVirtualTimeSet sends virtual_time_set event", () => {
			trackVirtualTimeSet("2001-09-11T12:46:00Z", "init");
			expect(mockEvent).toHaveBeenCalledWith("virtual_time_set", {
				time: "2001-09-11T12:46:00Z",
				source: "init",
			});
		});

		it("trackChannelChange sends channel_change event", () => {
			trackChannelChange("CNN", "ABC");
			expect(mockEvent).toHaveBeenCalledWith("channel_change", {
				from: "CNN",
				to: "ABC",
			});
		});

		it("trackAppToggle sends app_toggle event", () => {
			trackAppToggle("TV.app", "open");
			expect(mockEvent).toHaveBeenCalledWith("app_toggle", {
				app: "TV.app",
				action: "open",
			});
		});

		it("trackPauseResume sends pause_resume with virtual time", () => {
			trackPauseResume("pause", "2001-09-11T12:46:00Z");
			expect(mockEvent).toHaveBeenCalledWith("pause_resume", {
				action: "pause",
				virtualTime: "2001-09-11T12:46:00Z",
			});
		});

		it("getSessionURL passes options object and returns the URL", () => {
			mockGetSessionURL.mockReturnValue("https://openreplay.test/s/abc123");
			expect(getSessionURL()).toBe("https://openreplay.test/s/abc123");
			expect(mockGetSessionURL).toHaveBeenCalledWith({ withCurrentTime: false });
		});

		it("getSessionURL passes withCurrentTime=true when requested", () => {
			mockGetSessionURL.mockReturnValue("https://openreplay.test/s/abc123?t=42");
			expect(getSessionURL(true)).toBe("https://openreplay.test/s/abc123?t=42");
			expect(mockGetSessionURL).toHaveBeenCalledWith({ withCurrentTime: true });
		});

		it("getSessionID returns the session id string", () => {
			mockGetSessionID.mockReturnValue("session-xyz");
			expect(getSessionID()).toBe("session-xyz");
		});

		describe("identifyUser", () => {
			beforeEach(() => {
				mockSetUserID.mockClear();
				mockSetMetadata.mockClear();
				identifyUser(null); // reset any identity left by a previous test
				mockSetUserID.mockClear();
			});

			it("sets userID to email and userId metadata on sign-in", () => {
				identifyUser({ id: "u-1", email: "jane@example.com" });
				expect(mockSetUserID).toHaveBeenCalledWith("jane@example.com");
				expect(mockSetMetadata).toHaveBeenCalledWith("userId", "u-1");
			});

			it("falls back to the user id when email is null", () => {
				identifyUser({ id: "u-2", email: null });
				expect(mockSetUserID).toHaveBeenCalledWith("u-2");
			});

			it("does not re-identify the same user twice", () => {
				identifyUser({ id: "u-1", email: "jane@example.com" });
				identifyUser({ id: "u-1", email: "jane@example.com" });
				expect(mockSetUserID).toHaveBeenCalledTimes(1);
			});

			it("blanks the userID on sign-out after an identification", () => {
				identifyUser({ id: "u-1", email: "jane@example.com" });
				identifyUser(null);
				expect(mockSetUserID).toHaveBeenLastCalledWith("");
			});

			it("does nothing for a null user when nobody was identified", () => {
				identifyUser(null);
				expect(mockSetUserID).not.toHaveBeenCalled();
			});
		});
	});

	describe("initTracker with no project key", () => {
		it("does not construct a Tracker when key is absent", async () => {
			vi.stubEnv("VITE_OPENREPLAY_PROJECT_KEY", "");
			const { default: MockTracker } = await import("@openreplay/tracker");
			const callsBefore = vi.mocked(MockTracker).mock.calls.length;
			initTracker();
			expect(vi.mocked(MockTracker).mock.calls.length).toBe(callsBefore);
		});

		it("event helpers do not call tracker.event when uninitialised", () => {
			mockEvent.mockClear();
			trackVirtualTimeSet("2001-09-11T12:46:00Z", "seek");
			expect(mockEvent).not.toHaveBeenCalled();
		});
	});
});
