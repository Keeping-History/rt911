import { test as base, expect, type Page } from "@playwright/test";

// Shared e2e fixtures. Extend here (per packages/frontend/CLAUDE.md) rather than
// duplicating setup across specs.
//
// The desktop boots behind a pre-boot "power on" About / content-warning overlay
// (ClassicyDesktop's `preBootScreen`). Until POWER ON is clicked the desktop app
// icons aren't rendered, so any spec that opens an app via icon double-click would
// hang waiting for an icon that doesn't exist yet. Register a locator handler on
// the `page` fixture: whenever an action is blocked and the overlay is showing,
// Playwright auto-clicks POWER ON, boots, and retries the action. Specs that never
// reach the desktop (the iPod shell) never trigger it, so it adds no overhead there.
export const test = base.extend({
	// `runTest` is Playwright's fixture callback (conventionally named `use`);
	// renamed so eslint's react-hooks rule doesn't mistake it for React's `use`.
	page: async ({ page }, runTest) => {
		await page.addLocatorHandler(
			page.getByRole("button", { name: "POWER ON" }),
			async (button) => {
				await button.click();
			},
		);
		await runTest(page);
	},
});

export { expect };

/**
 * Pause the virtual clock via Time Machine's own Pause button (the one
 * sanctioned user-driven writer — see packages/frontend/CLAUDE.md's "one
 * virtual clock, one writer seam"), then close its window.
 *
 * A spec that asserts which LANE a card is in (LIVE/UPCOMING/PREVIOUS) is
 * asserting against the clock: without pinning it, a card can migrate lanes
 * between the assertion setting up and the assertion running, against a real
 * dev server with no way to control wall-clock time. `pause()` freezes
 * `getNowMs()` everywhere that reads `useClassicyDateTime({ tick: true })`
 * (see RadioTraffic.tsx's `clockPausedRef`), not just Time Machine's own UI.
 *
 * Deliberately does NOT jump the clock (Time Machine's ⇛/⇚) before pausing.
 * A jump is a seek (`SEEK_THRESHOLD_MS`, MediaStreamProvider) that can land on
 * an instant with nothing in the reveal buffer's forward-looking window — a
 * frozen clock never revisits the server for a bigger one — and a jump large
 * enough to reliably clear that risk can itself cross an Alerts.app event
 * boundary and pop a modal mid-setup. Simplest robust order, used by every
 * caller here: let the clock run forward in ordinary real time from boot
 * (`app.tsx`'s seeded 8:40 AM) until whatever the caller is waiting for shows
 * up, THEN call this to freeze the moment — see radio-traffic.spec.ts's first
 * test for the shape.
 *
 * The window is closed afterwards, not left open: `ClassicyWindow` gives the
 * whole app a `role="application"` landmark labelled by its title, and a
 * caller scoping later locators to `Radio Traffic`'s own application landmark
 * must not have Time Machine's still-open window physically overlapping it
 * and stealing the hit-test.
 */
export async function pinVirtualClock(page: Page): Promise<void> {
	await page.getByRole("button", { name: "Time Machine" }).dblclick();

	const timeMachine = page.getByRole("application", { name: "Time Machine" });
	const pauseButton = timeMachine.getByRole("button", { name: "Pause", exact: true });
	// The default 5s expect timeout is too tight for this specific moment: every
	// caller here reaches this point right after the caller's own poll loop has
	// been busy against a real, data-heavy session (see this function's own doc
	// comment), so the app can legitimately still be finishing that work when
	// Time Machine's window is asked to open on top of it. 20s observed to be
	// comfortably enough in CI without eating meaningfully into the 90s test
	// budget the caller's own wait already leaves room against.
	await expect(pauseButton).toBeVisible({ timeout: 20_000 });
	// Already paused (e.g. a persisted state) is not a failure — just don't
	// press a disabled button.
	if (await pauseButton.isEnabled()) {
		await pauseButton.click();
	}
	await expect(pauseButton).toBeDisabled();

	// force: true — the close box's actionability pre-checks (element
	// "stable", receiving events at its own point) hang indefinitely on this
	// tiny utility-window control in a way a plain click does not on any other
	// window's close box in this repo's specs; the element is visible and its
	// position is otherwise unremarkable (see the story's Work Log).
	await timeMachine.locator(".classicyWindowCloseBox").click({ force: true });
	await expect(timeMachine).toHaveCount(0);
}
