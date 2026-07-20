import { expect, test } from "../fixtures";

// Playlist editor app: sign-in gate + basic create/save flow. Interacts via
// the desktop icon double-click (never Classicy menu UI), mirroring
// account.spec.ts / feedback.spec.ts conventions. All Directus calls are
// intercepted — no live API dependency.

const ME = { id: "u1", email: "t@example.org", first_name: "Teach" };

test("anonymous open shows the gate; Quit closes the app", async ({ page }) => {
	await page.route("**/users/me**", (route) =>
		route.fulfill({
			status: 401,
			contentType: "application/json",
			body: JSON.stringify({ errors: [] }),
		}),
	);
	await page.goto("/");
	await page.getByRole("button", { name: "Playlists" }).dblclick();
	await expect(page.getByText("You must be signed in to create playlists.")).toBeVisible();
	await page.getByRole("button", { name: "Quit" }).click();
	await expect(page.getByText("You must be signed in to create playlists.")).toBeHidden();
});

test("signed-in teacher creates and saves a playlist", async ({ page }) => {
	await page.route("**/users/me**", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ data: ME }),
		}),
	);
	await page.route("**/items/playlists?*", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ data: [] }),
		}),
	);

	let createdBody: Record<string, unknown> | null = null;
	await page.route("**/items/playlists", (route) => {
		if (route.request().method() !== "POST") return route.fallback();
		createdBody = route.request().postDataJSON() as Record<string, unknown>;
		return route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				data: {
					id: "p9",
					title: "Untitled Playlist",
					status: "draft",
					definition: createdBody.definition,
					date_updated: null,
					user_created: "u1",
				},
			}),
		});
	});

	await page.goto("/");
	await page.getByRole("button", { name: "Playlists" }).dblclick();
	await expect(page.getByText("My Playlists", { exact: true })).toBeVisible();

	await page.getByRole("button", { name: "New", exact: true }).click();

	await expect(page.getByRole("textbox", { name: "Title" })).toBeVisible();
	await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Untitled Playlist");
	expect(createdBody).toMatchObject({ title: "Untitled Playlist", status: "draft" });
});
