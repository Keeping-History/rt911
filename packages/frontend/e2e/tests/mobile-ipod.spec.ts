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
		// The menu is stream-independent (only the Radio screen needs the
		// WebSocket), so this navigation works even where the streamer is
		// unreachable — e.g. CI runners with no .env.
		await page.getByText("About", { exact: true }).tap();
		await expect(page.getByText(/adapted from mitchivin/)).toBeVisible();
		await page.locator("#menu-btn").tap();
		await expect(page.getByText("Radio", { exact: true })).toBeVisible();
	});
});
