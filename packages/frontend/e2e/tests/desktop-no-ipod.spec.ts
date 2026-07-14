import { expect, test } from "@playwright/test";

test("desktop never renders the iPod shell", async ({ page }) => {
	await page.goto("/");
	// Wait for the lazy desktop branch to actually mount first — a bare
	// toHaveCount(0) would pass trivially during the Suspense window before
	// either chunk loads.
	await expect(page.locator(".classicyDesktop")).toBeVisible();
	await expect(page.locator(".ipodRoot")).toHaveCount(0);
});
