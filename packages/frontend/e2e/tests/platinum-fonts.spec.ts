import { expect, test } from "@playwright/test";

// classicy 0.70.0 split every base64 @font-face rule out of classicy.css into
// an opt-in dist/fonts.css. Forgetting that second import didn't throw and
// didn't warn: the stylesheets still ask for "Charcoal, ChicagoFLF, Geneva",
// the browser finds no such faces, silently falls back to sans-serif, and the
// entire Platinum look is gone behind a green build and a clean console. That
// shipped to production once. This is the tripwire.
//
// Classicy 3 moved the fonts into the Platinum Appearance Package
// (@classicy/appearance-platinum), which registers them as .woff2 @font-face
// rules when boot/AppProviders.tsx imports it. Without that import there is
// no desktop at all (Classicy shows its "No Appearance Package is loaded"
// screen), which the first assertion catches; a dev server that pre-bundles
// classicy (optimizeDeps) serves the font files as the SPA page instead.
//
// Deliberately NOT document.fonts.check(): it returns TRUE when no matching
// @font-face exists at all, because the fallback family satisfies it. It
// therefore passes in exactly the broken case — verified against production
// while it was still degraded.
test("the Platinum @font-face rules are registered", async ({ page }) => {
	await page.goto("/");
	await expect(page.locator(".classicyDesktop")).toBeVisible();
	await expect(page.locator(".classicyDesktop")).toHaveAttribute(
		"data-classicy-appearance",
		"platinum",
	);

	const { families, failed } = await page.evaluate(async () => {
		await document.fonts.ready;
		const faces = [...document.fonts];
		return {
			families: [...new Set(faces.map((f) => f.family))].sort(),
			// A face whose file came back as something other than a font (the SPA
			// fallback page a pre-bundling dev server serves) ends in "error".
			failed: faces.filter((f) => f.status === "error").map((f) => f.family),
		};
	});

	expect(families).toEqual(
		expect.arrayContaining(["Charcoal", "ChicagoFLF", "Geneva", "Monaco"]),
	);
	expect(failed).toEqual([]);
});
