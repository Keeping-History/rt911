import { expect, test } from "../fixtures";

// Teacher-playlist boot flow: ?playlist=<id> loads a Directus row (intercepted
// here — no live API dependency), disables an app, and seeds app settings.
// Assertions go against behavior + persisted store state, never Classicy menu
// UI (menu clicks are flaky — see project memory).
const definition = {
	version: 1,
	mode: "annotate",
	entries: [
		{ kind: "app", appId: "TimeMachine.app", disabled: true },
		{ kind: "settings", appId: "TV.app", values: { captionsOn: true } },
	],
};

test("playlist disables an app and seeds settings", async ({ page }) => {
	await page.route("**/items/playlists/e2e-test", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				data: { id: "e2e-test", title: "E2E", status: "published", definition },
			}),
		}),
	);
	await page.goto("/?playlist=e2e-test");
	await expect(page.locator(".classicyDesktop")).toBeVisible();

	// Settings seeded into the store (assert via the persisted desktop state).
	await expect
		.poll(
			async () =>
				page.evaluate(() => {
					const raw = localStorage.getItem("classicyDesktopState");
					if (!raw) return undefined;
					const s = JSON.parse(raw) as {
						System?: {
							Manager?: {
								Applications?: {
									apps?: Record<string, { data?: { captionsOn?: boolean } }>;
								};
							};
						};
					};
					return s?.System?.Manager?.Applications?.apps?.["TV.app"]?.data?.captionsOn;
				}),
			{ timeout: 15_000 },
		)
		.toBe(true);

	// Opening the disabled app (double-click its desktop icon) surfaces the
	// permission dialog and the app does not stay open.
	await page.getByRole("button", { name: "Time Machine" }).dblclick();
	await expect(
		page.getByText("You don't have permission to open this app."),
	).toBeVisible();
});
