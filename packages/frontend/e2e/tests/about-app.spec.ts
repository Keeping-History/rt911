import { expect, test } from "../fixtures";

// Regression guard for Finding 1 of the about-provenance final review: the
// About window's own ClassicyWindow registers itself via ClassicyWindowOpen
// on every mount, but that reducer only focuses a *genuinely new* window --
// a re-registered persisted window (i.e. this same About window on every
// reopen after the first) is deliberately left unfocused, so without
// AboutAppWindow explicitly focusing itself (AboutApp.tsx), a reopened About
// window would render dimmed (classicyWindowInactive) and behind the app's
// own main window (classicyWindowActiveApp, z-index 150) -- unclickable
// because it's underneath. No unit test can see this: this repo's unit-test
// pattern (AboutApp.test.tsx) stubs ClassicyWindow to a children-passthrough
// that discards the props the real z-index banding depends on. Only a real
// browser, driving the real classicy window manager end to end, can.
//
// Weather is picked because it has no auth/network dependency to stub.
test("About window stays on top across close and reopen", async ({ page }) => {
	await page.goto("/");
	await expect(page.locator(".classicyDesktop")).toBeVisible();

	await page.getByRole("button", { name: "Weather" }).dblclick();
	await expect(page.getByRole("application", { name: "Weather" })).toBeVisible();

	const openAbout = async () => {
		await page.getByRole("menuitem", { name: "Help" }).click();
		// exact: true is required here -- ARIA accessible-name computation folds
		// every descendant menuitem's text into the "Help" top-level item's own
		// name (it contains the whole open submenu), so a substring/regex match
		// for "About Weather" matches BOTH the "Help" item and this leaf item.
		await page.getByRole("menuitem", { name: "About Weather…", exact: true }).click();
	};

	// First open: the About window is genuinely new, so classicy's own
	// ClassicyWindowOpen handler focuses it unassisted -- this passes even
	// without Finding 1's fix, and establishes the baseline this test is
	// contrasting the reopen against.
	await openAbout();
	const aboutWindow = page.getByRole("application", { name: "About Weather" });
	await expect(aboutWindow).toBeVisible();
	await expect(aboutWindow).toHaveClass(/classicyWindowActive\b/);
	await expect(aboutWindow).not.toHaveClass(/classicyWindowInactive/);
	await expect(aboutWindow.getByText(/NOAA NCEI/)).toBeVisible();

	// Close via the window's own close box (exercises ClassicyWindow's close(),
	// which already dispatches ClassicyWindowClose before onCloseFunc).
	await aboutWindow.locator(".classicyWindowCloseBox").click();
	await expect(aboutWindow).toBeHidden();

	// Reopen: this is the regression this spec exists for. Before Finding 1's
	// fix, the reopened window rendered classicyWindowInactive/
	// classicyWindowActiveApp -- dimmed and occluded by the Weather app's own
	// main window -- because the window record already existed in the store
	// from the first open, so ClassicyWindowOpen's own focus-on-register
	// branch didn't fire a second time.
	await openAbout();
	await expect(aboutWindow).toBeVisible();
	await expect(aboutWindow).toHaveClass(/classicyWindowActive\b/);
	await expect(aboutWindow).not.toHaveClass(/classicyWindowInactive/);
	await expect(aboutWindow.getByText(/NOAA NCEI/)).toBeVisible();

	// Close via the in-window OK button (Finding 6): it used to bypass
	// ClassicyWindow's close() entirely, dispatching nothing, leaving the
	// Weather app's main window dimmed (classicyWindowInactive) afterward.
	await aboutWindow.getByRole("button", { name: "OK" }).click();
	await expect(aboutWindow).toBeHidden();
	await expect(page.getByRole("application", { name: "Weather" })).toHaveClass(
		/classicyWindowActive\b/,
	);
});
