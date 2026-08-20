import { expect, test } from "@playwright/test";

// Imports @playwright/test directly rather than the shared fixtures: the fixture
// page installs a locator handler that auto-clicks POWER ON, which would boot
// the desktop out from under the assertions below.
test("POWER ON holds focus on load so Enter dismisses the overlay", async ({
	page,
}) => {
	await page.goto("/");
	const powerOn = page.getByRole("button", { name: "POWER ON" });
	await expect(powerOn).toBeFocused();

	// Keyboard only — no click. A focused native button turns Enter into a
	// click, so this is the whole "just press enter to close it" path.
	await page.keyboard.press("Enter");
	await expect(powerOn).toHaveCount(0);
});
