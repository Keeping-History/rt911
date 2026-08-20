import { expect, test } from "../fixtures";

// Regression guard for the Finder list view losing every mouse click on real
// cell content (classicy ClassicyTable, post-0.75.0).
//
// ClassicyTable rendered each cell through TanStack's flexRender, which treats
// a renderer function as a COMPONENT TYPE. React reconciles types by identity,
// so the renderer being re-created on any render made every cell's DOM unmount
// and rebuild. Any re-render landing mid-press (the Finder passes fresh inline
// callbacks; clicking a window also updates the desktop store) therefore
// detached the node that had received `mousedown` -- and the browser refuses to
// synthesize a `click` when that node is gone by the time `mouseup` finishes
// dispatching. The rows still LOOKED right and every unit test still passed:
// the filename label, the icon and the disclosure triangle simply stopped
// responding, while a click on a cell's empty padding (whose target is the
// long-lived <td>) still worked -- which is why this needs a real browser.
test("Finder list view rows select and disclose on click", async ({ page }) => {
	await page.goto("/");
	await expect(page.locator(".classicyDesktop")).toBeVisible();

	await page.getByRole("button", { name: "Macintosh HD" }).dblclick();
	const rows = page.locator("tr[data-row-id]");
	await expect(rows.first()).toBeVisible();

	// Clicking the filename label -- content rendered INSIDE the cell, the exact
	// target the bug swallowed -- selects that row.
	const applications = page.locator('tr[data-row-id="Macintosh HD:Applications"]');
	await applications.getByText("Applications").click();
	await expect(applications).toHaveAttribute("data-selected", "true");
	await expect(applications).toHaveClass(/classicyFileBrowserViewTableRowSelected/);

	// The disclosure triangle expands the folder in place (and, because the
	// triangle swallows the click, without doubling as a row selection).
	const systemFolder = page.locator('tr[data-row-id="Macintosh HD:System Folder"]');
	await systemFolder
		.locator(".classicyFileBrowserViewTableDisclosureTriangle")
		.click();
	await expect(
		page.locator('tr[data-row-id^="Macintosh HD:System Folder:"]').first(),
	).toBeVisible();
	await expect(systemFolder).not.toHaveAttribute("data-selected", "true");

	// Collapsing puts the children away again.
	await systemFolder
		.locator(".classicyFileBrowserViewTableDisclosureTriangle")
		.click();
	await expect(
		page.locator('tr[data-row-id^="Macintosh HD:System Folder:"]'),
	).toHaveCount(0);
});
