import { expect, test } from "@playwright/test";

// classicy 0.70.0 split every base64 @font-face rule out of classicy.css into
// an opt-in dist/fonts.css. Forgetting that second import doesn't throw and
// doesn't warn: the stylesheets still ask for "Charcoal, ChicagoFLF, Geneva",
// the browser finds no such faces, silently falls back to sans-serif, and the
// entire Platinum look is gone behind a green build and a clean console. That
// shipped to production once. This is the tripwire.
//
// Deliberately NOT document.fonts.check(): it returns TRUE when no matching
// @font-face exists at all, because the fallback family satisfies it. It
// therefore passes in exactly the broken case — verified against production
// while it was still degraded.
test("the Platinum @font-face rules are registered", async ({ page }) => {
	await page.goto("/");
	await expect(page.locator(".classicyDesktop")).toBeVisible();

	const families = await page.evaluate(async () => {
		await document.fonts.ready;
		return [...new Set([...document.fonts].map((f) => f.family))].sort();
	});

	expect(families).toEqual(
		expect.arrayContaining(["Charcoal", "ChicagoFLF", "Geneva", "Monaco"]),
	);
});
