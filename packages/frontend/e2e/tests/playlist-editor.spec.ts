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

/**
 * Opens the Playlists app, signed in, onto ONE existing playlist ("Lane Label
 * Test") whose definition already has the given media entries. The default is
 * a radio bar with no start/end, so it fades across the whole ten-day span and
 * stays under the pointer at any scroll position; pass a `tv` entry instead to
 * exercise the thumbnail-strip preview, which renders for no other group. All
 * Directus calls are intercepted; there is no shared helper for this in the
 * spec yet, so this one is local to this file rather than duplicated across
 * tests.
 */
async function openPlaylistWithEntries(
	page: import("@playwright/test").Page,
	entries: Record<string, unknown>[] = [{ kind: "media", app: "radio", itemId: "wcbs" }],
) {
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
			body: JSON.stringify({
				data: [
					{
						id: "p1",
						title: "Lane Label Test",
						status: "draft",
						date_updated: null,
						user_created: "u1",
					},
				],
			}),
		}),
	);
	await page.route("**/items/playlists/p1", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				data: {
					id: "p1",
					title: "Lane Label Test",
					status: "draft",
					date_updated: null,
					user_created: "u1",
					definition: { version: 1, mode: "annotate", entries },
				},
			}),
		}),
	);

	await page.goto("/");
	await page.getByRole("button", { name: "Playlists" }).dblclick();
	const row = page.getByText("Lane Label Test", { exact: true });
	await expect(row).toBeVisible();
	await row.dblclick();
	await expect(page.getByRole("application", { name: "Lane Label Test" })).toBeVisible();
}

test("lane label stays visible when the timeline is scrolled", async ({ page }) => {
	await openPlaylistWithEntries(page);
	await page.getByRole("button", { name: "Zoom in" }).click();
	await page.getByRole("button", { name: "Zoom in" }).click();

	const label = page.locator(".playlistTimelineLabel").first();
	const timeline = page.locator(".playlistTimeline");
	await expect(label).toBeVisible();

	await timeline.evaluate((el) => {
		el.scrollLeft = el.scrollWidth / 3;
	});

	// The label must still be inside the viewport, not scrolled off to the left.
	const box = await label.boundingBox();
	const view = await timeline.boundingBox();
	expect(box).not.toBeNull();
	expect(view).not.toBeNull();
	expect(box!.x).toBeGreaterThanOrEqual(view!.x - 1);
});

/**
 * The sticky-label test above cannot catch a broken preview: its fixture entry
 * is `radio`, and LanePreview renders for `tv` only. A strip that fills the
 * whole zoom*100% lane still LOOKS sticky in the stylesheet while measuring as
 * a no-op in the browser, so this asserts the rendered geometry directly, with
 * a TV entry selected.
 */
test("selected TV lane's thumbnail strip stays visible when the timeline is scrolled", async ({
	page,
}) => {
	// A 1x1 GIF for every thumbnail: the real ones live on Wasabi, and an e2e
	// run must not depend on that (or on offline.jpg's error path firing).
	await page.route("**/thumbnails/**", (route) =>
		route.fulfill({
			status: 200,
			contentType: "image/gif",
			body: Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
		}),
	);
	await openPlaylistWithEntries(page, [{ kind: "media", app: "tv", itemId: "cnn" }]);

	// Selecting the bar is what expands the lane into a preview. Clicked near
	// its left end rather than at its centre: the bar spans the whole ten-day
	// track, and the floating Tools palette covers the middle of the timeline.
	await page.locator(".playlistTimelineBar").first().click({ position: { x: 20, y: 8 } });
	const strip = page.locator(".playlistTimelinePreview");
	await expect(strip).toBeVisible();

	for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Zoom in" }).click();

	const timeline = page.locator(".playlistTimeline");
	await timeline.evaluate((el) => {
		el.scrollLeft = el.scrollWidth / 3;
	});
	await expect(strip).toBeVisible();

	// Pinned to the visible left edge, and no wider than the window it sits in —
	// the failure mode was a strip as wide as the whole track, starting thousands
	// of pixels to the left of the viewport. Polled rather than read once: the
	// strip is re-derived from a throttled scroll measurement.
	await expect
		.poll(async () => {
			const box = await strip.boundingBox();
			const view = await timeline.boundingBox();
			if (!box || !view) return null;
			return {
				insideLeft: box.x >= view.x - 1,
				insideRight: box.x <= view.x + view.width,
				narrowerThanView: box.width <= view.width + 1,
			};
		})
		.toEqual({ insideLeft: true, insideRight: true, narrowerThanView: true });
});
