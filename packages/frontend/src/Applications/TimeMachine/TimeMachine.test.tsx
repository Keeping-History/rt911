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

// Seed the persisted-window store so the Settings window is open on mount —
// the Settings ClassicyWindow is always mounted and reads its open/closed
// state straight from this store (see TimeMachine.tsx). Mirrors how a page
// reload restores a previously-open window, and avoids having to drive the
// real Classicy menu bar (which lives in ClassicyDesktop, not mounted here)
// just to click File > Settings….
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
									// classicy.es.js) — ClassicyWindow reads this array entry as
									// its full live window state, so a partial record renders
									// blank instead of opening.
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

	// Regression test for the bug this suite's rewrite fixed: Cancel/Save used
	// to only flip TimeMachine's own local `showSettings` boolean, never
	// telling Classicy's store the window had closed — so the store's
	// persisted `closed` stayed false, and the window reappeared (unwanted)
	// on the next reload even though the user had dismissed it. The window is
	// now always mounted and Cancel/Save dispatch ClassicyWindowClose, so the
	// store itself is the only thing that has to be right.
	it("dispatching Cancel persists closed to the Classicy store, not just local state", () => {
		openSettingsOnMount();
		render(<TimeMachine />);

		expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		const settingsWindow = useAppManager
			.getState()
			.System.Manager.Applications.apps[TIME_MACHINE_APP_ID]?.windows?.find(
				(w: { id: string }) => w.id === `${TIME_MACHINE_APP_ID}_settings`,
			) as { closed?: boolean } | undefined;
		expect(settingsWindow?.closed).toBe(true);
	});
});

describe("TimeMachine Bookmarks window", () => {
	// Bookmarks is converted to the same always-mounted + dispatch pattern as
	// Settings, for consistency and to remove the latent risk: unlike
	// Settings, Bookmarks never had a Cancel/Save-style button that bypassed
	// Classicy's own close mechanism, so (unlike Settings) this suite hasn't
	// reproduced a concrete persistence bug here — closing only ever went
	// through the native close box, which Classicy already tracks correctly,
	// and mounting the old conditionally-rendered window already told
	// Classicy's store it was open. This test just guards the new path:
	// openBookmarks dispatches ClassicyWindowOpen/Focus directly rather than
	// relying on mount-as-a-side-effect to register openness.
	it("opening Bookmarks via the capture-dialog login prompt persists open to the Classicy store", () => {
		openSettingsOnMount(); // seeds apps[id].open — needed for ClassicyApp to render children at all
		render(<TimeMachine />);

		// Not signed in (AuthContext defaults to "anonymous" in this suite), so
		// Capture Bookmark opens Bookmarks instead of the capture dialog.
		fireEvent.click(screen.getByLabelText("Capture Bookmark"));

		const bookmarksWindow = useAppManager
			.getState()
			.System.Manager.Applications.apps[TIME_MACHINE_APP_ID]?.windows?.find(
				(w: { id: string }) => w.id === `${TIME_MACHINE_APP_ID}_bookmarks`,
			) as { closed?: boolean } | undefined;
		expect(bookmarksWindow?.closed).toBe(false);
	});
});
