import { expect, test } from "@playwright/test";

test("?ipod forces the iPod shell on a desktop browser", async ({ page }) => {
	await page.goto("/?ipod");
	await expect(page.locator(".ipodRoot")).toBeVisible();
	await expect(page.locator(".classicyDesktop")).toHaveCount(0);
});
