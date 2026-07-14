import { expect, test } from "@playwright/test";

test.describe("mobile iPod shell", () => {
	test("boots to the iPod instead of the desktop", async ({ page }) => {
		await page.goto("/");
		await expect(page.locator(".ipodRoot")).toBeVisible();
		// The desktop chunk must not have mounted.
		await expect(page.locator(".classicyDesktop")).toHaveCount(0);
	});

	test("navigates the menu by touch and back via MENU", async ({ page }) => {
		await page.goto("/");
		// Menu list may sit behind the Connecting… state briefly; About works
		// without stream data once the menu is up.
		await page.getByText("About", { exact: true }).tap();
		await expect(page.getByText(/adapted from mitchivin/)).toBeVisible();
		await page.locator("#menu-btn").tap();
		await expect(page.getByText("Radio", { exact: true })).toBeVisible();
	});
});
