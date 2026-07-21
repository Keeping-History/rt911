import { test as base, expect } from "@playwright/test";

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
