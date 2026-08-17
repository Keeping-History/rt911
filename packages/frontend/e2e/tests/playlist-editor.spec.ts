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
	// Scoped to the list window's own content: "My Playlists" is also the text
	// of the Window menu's item for that window, so a bare getByText is
	// ambiguous now that the app has a Window menu. (It is a control label
	// beside the playlists table now, not a heading.)
	const listHeading = page.locator(".playlistList").getByText("My Playlists");
	await expect(listHeading).toBeVisible();

	await page.getByRole("button", { name: "New", exact: true }).click();

	// The header title field is gone: a new playlist now opens in its OWN
	// document window, whose title bar carries the playlist title…
	await expect(page.getByRole("application", { name: "Untitled Playlist" })).toBeVisible();
	// …and the list window stays open alongside it, which is the whole point of
	// the document-based rework.
	await expect(listHeading).toBeVisible();
	expect(createdBody).toMatchObject({ title: "Untitled Playlist", status: "draft" });
});
