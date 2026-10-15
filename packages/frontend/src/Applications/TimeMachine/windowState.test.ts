import type { ClassicyStoreSystemAppWindow, ClassicyStoreSystemAppWindows } from "classicy";
import { describe, expect, it } from "vitest";
import { isWindowOpen } from "./windowState";

// A persisted window entry carries position, size, focus, … — only `id` and
// `closed` matter to isWindowOpen, so tests build just those.
const windows = (...entries: { id: string; closed: boolean }[]): ClassicyStoreSystemAppWindows =>
	Object.fromEntries(
		entries.map((w) => [w.id, w as unknown as ClassicyStoreSystemAppWindow]),
	);

// Classicy persists each app's window entries (id + closed flag) to
// localStorage, but TimeMachine gates the Settings/Bookmarks windows behind
// ephemeral React state that resets on reload. This helper reconciles the two:
// it answers "was this window open (present and not closed) in the persisted
// store?" so the app can restore its visibility on mount.
describe("isWindowOpen", () => {
	it("returns false when the windows record is undefined", () => {
		expect(isWindowOpen(undefined, "TimeMachine.app_settings")).toBe(false);
	});

	it("returns false when no window carries the id", () => {
		expect(
			isWindowOpen(
				windows({ id: "TimeMachine.app_main", closed: false }),
				"TimeMachine.app_settings",
			),
		).toBe(false);
	});

	it("returns true when the window exists and is not closed", () => {
		expect(
			isWindowOpen(
				windows({ id: "TimeMachine.app_settings", closed: false }),
				"TimeMachine.app_settings",
			),
		).toBe(true);
	});

	it("returns false when the window exists but is closed", () => {
		expect(
			isWindowOpen(
				windows({ id: "TimeMachine.app_settings", closed: true }),
				"TimeMachine.app_settings",
			),
		).toBe(false);
	});
});
