// packages/frontend/src/Applications/TimeMachine/TimeMachine.test.tsx
//
// Deliberately NO vi.mock("classicy"): this exercises the real manifest
// registry (the registerApp() side effect in timeMachineSettings.ts) and the
// real describeAppState()/ClassicyBalloonHelp wiring, proving the
// manifest -> balloon path end-to-end (see appManifests.test.ts for the same
// no-mock pattern).
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeAppState, useAppManager } from "classicy";
import { TIME_MACHINE_APP_ID, TimeMachineDataSchema } from "./timeMachineSettings";
import { TimeMachine } from "./TimeMachine";

beforeEach(() => {
	// useBookmarks fires a fetch on mount regardless of which window is open;
	// stub it out so this suite never hits the network.
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({
			ok: false,
			status: 404,
			json: async () => ({ data: [] }),
		}),
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

// Seed the persisted-window store so the Settings window is open on mount
// (isWindowOpen/readPersistedWindows in TimeMachine.tsx read this at first
// render) — mirrors how a page reload restores a previously-open window, and
// avoids having to drive the real Classicy menu bar (which lives in
// ClassicyDesktop, not mounted here) just to click File > Settings….
function openSettingsOnMount(): void {
	useAppManager.setState((s) => ({
		...s,
		System: {
			...s.System,
			Manager: {
				...s.System.Manager,
				Applications: {
					...s.System.Manager.Applications,
					apps: {
						...s.System.Manager.Applications.apps,
						[TIME_MACHINE_APP_ID]: {
							...(s.System.Manager.Applications.apps[TIME_MACHINE_APP_ID] ?? {}),
							// ClassicyApp only gates its children on apps[id].open — and
							// only sets that itself on a *first-ever* ClassicyAppLoad (an
							// existing entry, which pre-seeding creates, is left alone) —
							// so it must be supplied here too, or the whole app renders
							// nothing.
							open: true,
							focused: true,
							windows: [
								{
									// Full shape classicy's own ClassicyWindow expects for a
									// persisted window entry (see zA's default-object literal in
									// classicy.es.js) — a bare {id, closed} (TimeMachine's own
									// PersistedWindow interface in windowState.ts) is enough for
									// TimeMachine's own isWindowOpen() check, but ClassicyWindow
									// reads this same array entry as its full live window state,
									// so a partial record renders blank instead of opening.
									id: `${TIME_MACHINE_APP_ID}_settings`,
									appId: TIME_MACHINE_APP_ID,
									closed: false,
									focused: true,
									collapsed: false,
									dragging: false,
									moving: false,
									resizing: false,
									zoomed: false,
									size: [300, 0],
									position: [250, 150],
									minimumSize: [300, 0],
									menuBar: [],
									default: false,
									windowType: "document",
								},
							],
						},
					},
				},
			},
		},
	}));
}

describe("describeAppState(TimeMachine.app)", () => {
	it("resolves the schema's .describe() text for each slider field", () => {
		// unwrap() twice: once for the outer `.optional()`, once for the field's
		// own optionality after `.partial()` — same shape describeAppState itself
		// walks (see the classicy manifest handoff §6).
		const settingsSchema = TimeMachineDataSchema.shape.settings.unwrap();
		const cases: Array<[keyof typeof settingsSchema.shape, string]> = [
			["skipMinutes", "Skip distance"],
			["stepSeconds", "Step distance"],
			["scrubSeconds", "Scrub distance"],
		];

		for (const [field] of cases) {
			const expected = settingsSchema.shape[field].unwrap().description;
			expect(expected).toBeTruthy();
			expect(
				describeAppState(TIME_MACHINE_APP_ID, `settings.${field}`)?.content,
			).toBe(expected);
		}
	});
});

describe("TimeMachine Settings window", () => {
	it("wraps each slider in balloon help sourced from the manifest, and the sliders still function", () => {
		vi.useFakeTimers();
		openSettingsOnMount();
		render(<TimeMachine />);

		const skipSlider = document.getElementById(
			"controls_skip_minutes",
		) as HTMLInputElement | null;
		const stepSlider = document.getElementById(
			"controls_step_seconds",
		) as HTMLInputElement | null;
		const scrubSlider = document.getElementById(
			"controls_scrub_seconds",
		) as HTMLInputElement | null;
		expect(skipSlider).not.toBeNull();
		expect(stepSlider).not.toBeNull();
		expect(scrubSlider).not.toBeNull();

		// Zero behavior change: the slider still updates its value/label on drag.
		fireEvent.change(skipSlider!, { target: { value: "45" } });
		expect(skipSlider!.value).toBe("45");
		expect(screen.getByText("45 min")).toBeTruthy();

		// Each slider is wrapped in ClassicyBalloonHelp's anchor (role="tooltip").
		const anchors = screen.getAllByRole("tooltip");
		expect(anchors.length).toBe(3);

		// Hovering the skip slider's balloon anchor reveals content pulled
		// straight from the manifest's schema .describe() text — not a
		// hand-duplicated string.
		const skipAnchor = skipSlider!.closest('[role="tooltip"]') as HTMLElement;
		fireEvent.mouseEnter(skipAnchor);
		act(() => {
			vi.advanceTimersByTime(600);
		});
		const expectedContent = describeAppState(
			TIME_MACHINE_APP_ID,
			"settings.skipMinutes",
		)?.content;
		expect(expectedContent).toBeTruthy();
		expect(screen.getByText("Skip distance")).toBeTruthy();
		expect(screen.getByText(expectedContent!)).toBeTruthy();
	});
});
