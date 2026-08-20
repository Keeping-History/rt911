import type { Locator, Page } from "@playwright/test";
import { expect, pinVirtualClock, test as base } from "../fixtures";

// Radio Traffic E2E: nothing here is mocked — the spec drives the real app
// against the real dev server, which in turn talks to the real (production)
// streamer at VITE_MEDIA_STREAM_URL. See packages/frontend/CLAUDE.md's "one
// WebSocket" rule and the repo's e2e convention (playlist.spec.ts is the one
// exception, intercepting a Directus row it does not own).
//
// Only the first test asserts LANE MEMBERSHIP (which of LIVE/UPCOMING/
// PREVIOUS a card is in) — a function of the virtual clock (cardStatus's
// laneFor) — so it is the only one that pins the clock (pinVirtualClock,
// e2e/fixtures) before asserting: a running clock racing a real server's real
// data would let a card change lanes between two assertions. The other tests
// (tool selection, tab switching, tag filtering) don't depend on which lane
// anything is in, so they run against the ordinary running clock — simpler,
// and it sidesteps a real trap pinning immediately at boot has (see that
// test's own comment).
//
// Two scenarios — checking a small-namespace tag, and the aircraft picker —
// depend on `GET /mp3/tags`, which is real backend infrastructure this branch
// has not been deployed with yet (confirmed by hand: the route exists in
// packages/backend/internal/handler/mp3meta.go but the deployed streamer
// 404s). FilterTree.tsx's own fallback for that is rendering "Tags
// unavailable." with no checkboxes at all (see tagVocabulary.ts's `stale`
// fallback degrading all the way to `[]` when there was never a good copy to
// fall back on) — `tagsAvailable` below detects exactly that shape and the
// two tests self-skip through it rather than failing on infrastructure this
// spec cannot fix.

const LANES = ["live", "upcoming", "previous"] as const;

function radioTrafficWindow(page: Page): Locator {
	return page.getByRole("application", { name: "Radio Traffic" });
}

async function openRadioTraffic(page: Page): Promise<Locator> {
	await page.getByRole("button", { name: "Radio Traffic" }).dblclick();
	const app = radioTrafficWindow(page);
	await expect(app.getByRole("radiogroup", { name: "Tools" })).toBeVisible({ timeout: 30_000 });
	await expect(app.getByRole("group", { name: "Tag filters" })).toBeVisible({ timeout: 30_000 });
	return app;
}

async function laneCardCounts(app: Locator): Promise<Record<(typeof LANES)[number], number>> {
	const out = {} as Record<(typeof LANES)[number], number>;
	for (const lane of LANES) {
		out[lane] = await app.locator(`[data-lane="${lane}"] [data-lane-item]`).count();
	}
	return out;
}

/**
 * Whether the tag vocabulary actually loaded — i.e. whether `GET /mp3/tags`
 * answered. FilterTree renders either a real checkbox (some namespace has
 * values) or the "Tags unavailable." notice (see FilterTree.tsx's `notice`);
 * racing both is how this avoids a fixed sleep.
 */
async function tagsAvailable(app: Locator): Promise<boolean> {
	const filterGroup = app.getByRole("group", { name: "Tag filters" });
	const notice = filterGroup.getByRole("status").filter({ hasText: "Tags unavailable." });
	const checkbox = filterGroup.locator('input[type="checkbox"]:visible').first();
	await Promise.race([
		notice.waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined),
		checkbox.waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined),
	]);
	return checkbox.isVisible();
}

// Serial, not parallel: every test in this file shares ONE Radio Traffic
// session against the one real (production) streamer (see the `hydrated`
// fixture below) rather than each opening its own — running N of these in
// parallel, each pulling the full mp3 history over its own WebSocket,
// saturates the shared connection badly enough that even a button click can
// miss Playwright's default timeout, observed directly on this machine (16
// cores, default worker count).
//
// The 90s per-test timeout (playwright.config.ts sets no override, so the
// default is 30s) gives the shared fixture's UPCOMING wait real room: unlike
// LIVE and PREVIOUS it can legitimately take up to a minute to fill from a
// cold connection — it comes from the reveal buffer's forward-looking window
// (MediaStreamProvider), not the history snapshot — observed directly, not a
// guess (see the fixture's own comment and the story's Work Log).

/**
 * One Radio Traffic session, opened and hydrated ONCE per worker, shared by
 * every test below — not per-test.
 *
 * 2026-08-20: this file used to open a fresh session per test. Against the
 * real (production) archive that is wall-clock-tied, a session opened later
 * in the suite's run has to catch up on a LARGER backlog than one opened
 * earlier — the backlog size grows with elapsed real time regardless of how
 * cheap any one item's render is, so per-test cold starts made every test
 * after the first progressively more likely to blow its own 90s budget, no
 * matter how much the render path itself was optimized (see git history
 * around this date for what got tried: TrafficCard memoization, PeaksWaveform
 * canvas-draw batching, LaneSection/Newsgroups re-render fixes — all real,
 * none sufficient, because none of them shrink a backlog that keeps growing
 * with wall-clock time). Paying the catch-up cost exactly once, then pinning
 * the clock immediately afterward so the backlog stops growing at all, is
 * what actually fixes it.
 *
 * Worker-scoped: `mode: "serial"` guarantees every test in this file runs in
 * the same worker, which is what makes a worker-scoped fixture safe to share
 * across them — Playwright will not hand two tests in this file to different
 * workers.
 */
const test = base.extend<Record<string, never>, { hydrated: { page: Page; app: Locator } }>({
	hydrated: [
		async ({ browser }, use) => {
			const page = await browser.newPage();
			await page.addLocatorHandler(page.getByRole("button", { name: "POWER ON" }), async (button) => {
				await button.click();
			});
			await page.goto("/");
			await expect(page.locator(".classicyDesktop")).toBeVisible({ timeout: 20_000 });
			const app = await openRadioTraffic(page);

			// Real data over a real WebSocket + HTTP history fetch takes a moment to
			// arrive, and the clock is deliberately left RUNNING (not yet pinned)
			// while waiting: UPCOMING fills from the reveal buffer's forward-looking
			// window rather than the history snapshot LIVE/PREVIOUS render from, and
			// that window can genuinely hold nothing at all for a stretch — a real,
			// observed gap, not a fixed-wait flake. A window that is currently empty
			// can still fill a few seconds later as ordinary real-time ticking
			// slides it forward over the archive's next item, but a clock pinned
			// BEFORE that happens never gets another chance to. So: wait for all
			// three lanes with the clock still running, and only pin it once every
			// lane genuinely has something — see pinVirtualClock's doc comment for
			// why this spec never seeks (jumps) the clock to force the issue
			// instead. One poll over the combined condition, not one poll per lane
			// sequentially — the latter could add up past the fixture's own budget
			// even though each individual lane resolves well within it.
			await expect
				.poll(
					async () => {
						const counts = await laneCardCounts(app);
						return LANES.every((lane) => counts[lane] > 0);
					},
					{ timeout: 70_000 },
				)
				.toBe(true);

			// Pinned once, here, for the whole file: every test below runs against
			// this same frozen instant, so lane membership cannot migrate under a
			// later test's feet AND no further archive backlog accumulates while
			// the remaining tests run.
			await pinVirtualClock(page);

			await use({ page, app });
			await page.close();
		},
		// Generous on purpose: this cost is now paid exactly ONCE per worker for
		// the whole file (five tests' worth of setup used to each separately
		// risk the old 90s per-test budget) — a couple of extra minutes of
		// headroom here is cheap insurance against the internal waits (desktop
		// visible, Tools/Tag-filters visible, the lane poll, pinVirtualClock's
		// own Time Machine wait) stacking up worse than usual on a given run.
		{ scope: "worker", timeout: 120_000 },
	],
});

test.describe.configure({ mode: "serial", timeout: 90_000 });

// Sharing one session (the `hydrated` fixture) means BOTH the tool palette
// and the tag filters now survive from whichever test ran before, not just
// within one test as they used to.
//
// "the tool palette" test below deliberately leaves the LAST tool it tried
// (Move, i.e. the `hand` tool) selected. RadioTraffic.tsx's own comment on the
// card slot explains why that matters beyond the palette itself: under
// `hand`, the slot's drag handlers run on the same pointer events a plain
// click needs, which broke the tab-bar test when it ran right after.
//
// "checking a small-namespace tag" leaves a tag checked, narrowing the
// visible set — which starved the aircraft-picker test's own "at least one
// card" wait when it ran right after, since FilterTree has no clear-all
// affordance to leave itself in a clean state.
//
// Reset both to their defaults before every test — Solo (arrow, the app's own
// DEFAULT_TOOL) and every tag unchecked — so each test starts from the same
// baseline regardless of run order or what a previous test left selected.
test.beforeEach(async ({ hydrated }) => {
	const { app } = hydrated;
	await app.getByRole("radiogroup", { name: "Tools" }).getByRole("radio", { name: "Solo", exact: true }).click();

	const filterGroup = app.getByRole("group", { name: "Tag filters" });
	const checked = filterGroup.locator('input[type="checkbox"]:checked');
	// One at a time: unchecking can shrink/reflow the visible checkbox list
	// (a namespace that had exactly this one checked value may collapse), so
	// re-querying the live NodeList after each uncheck is what keeps this from
	// racing its own DOM.
	// eslint-disable-next-line no-await-in-loop -- sequential on purpose, see above
	while (await checked.count()) {
		// eslint-disable-next-line no-await-in-loop -- sequential on purpose, see above
		await checked.first().uncheck();
	}
});

test("renders cards into the three lanes without them migrating", async ({ hydrated }) => {
	const { app } = hydrated;

	// The clock is already pinned (see the `hydrated` fixture) before this
	// test runs, so two samples taken any distance apart must already agree —
	// this is confirming the freeze holds, not waiting for one.
	const first = await laneCardCounts(app);
	await hydrated.page.waitForTimeout(4_000);
	const second = await laneCardCounts(app);
	expect(second).toEqual(first);
});

test("the tool palette activates exactly one tool at a time", async ({ hydrated }) => {
	const { app } = hydrated;
	const palette = app.getByRole("radiogroup", { name: "Tools" });
	const toolNames = ["Solo", "Mute", "Unmute", "Move"];

	for (const name of toolNames) {
		// exact: true — "Mute" is a substring of "Unmute", and Playwright's
		// accessible-name matching is substring by default.
		await palette.getByRole("radio", { name, exact: true }).click();
		for (const other of toolNames) {
			await expect(palette.getByRole("radio", { name: other, exact: true })).toHaveAttribute(
				"aria-checked",
				other === name ? "true" : "false",
			);
		}
	}
});

test("a card's tab bar switches panels", async ({ hydrated }) => {
	const { app } = hydrated;
	const card = app.locator("[data-item]").first();
	await expect(card).toBeVisible({ timeout: 30_000 });

	// Details is every card's first tab (CardTabBar.tsx's CARD_TABS) and is
	// always available, so it is the one panel guaranteed to be showing.
	await expect(card.locator('[data-tab="details"]')).toBeVisible();

	const tabBar = card.getByRole("tablist", { name: "Clip details" });
	const transcriptTab = tabBar.getByRole("tab", { name: "Transcript" });
	await transcriptTab.click();

	await expect(transcriptTab).toHaveAttribute("aria-selected", "true");
	await expect(tabBar.getByRole("tab", { name: "Details" })).toHaveAttribute(
		"aria-selected",
		"false",
	);
	await expect(card.locator('[data-tab="transcript"]')).toBeVisible();
	await expect(card.locator('[data-tab="details"]')).toHaveCount(0);
});

test("checking a small-namespace tag narrows the visible cards", async ({ hydrated }) => {
	const { app } = hydrated;

	if (!(await tagsAvailable(app))) {
		test.skip(
			true,
			"GET /mp3/tags 404s on the deployed streamer (this branch's backend isn't deployed yet) " +
				"— FilterTree shows 'Tags unavailable.' with no checkboxes. Self-resolves once the " +
				"backend ships; not fixable from the frontend.",
		);
	}

	const totalCards = () => app.locator("[data-item]").count();
	await expect.poll(totalCards, { timeout: 30_000 }).toBeGreaterThan(0);
	const before = await totalCards();

	// Any checkbox actually on screen belongs to a SMALL namespace — a large
	// one (aircraft/facility/person) renders a picker-opening button instead
	// (FilterTree.tsx's LargeNamespaceRow), never a checkbox. `:visible`
	// (Playwright's own pseudo-class) skips namespaces collapsed behind a
	// closed Disclosure (display:none while closed), landing on one of the
	// four namespaces open by default (tier/link/agency/role).
	const filterGroup = app.getByRole("group", { name: "Tag filters" });
	const tagCheckbox = filterGroup.locator('input[type="checkbox"]:visible').first();
	await tagCheckbox.check();
	await expect(tagCheckbox).toBeChecked();

	// matchesFilter (tagFilter.ts): an item with no tags at all cannot satisfy
	// a checked namespace, so checking any one real tag can only narrow — never
	// widen — the visible set.
	await expect.poll(totalCards, { timeout: 15_000 }).toBeLessThan(before);
});

test("opening the aircraft picker, typing and confirming narrows the cards further", async ({
	hydrated,
}) => {
	const { page, app } = hydrated;

	if (!(await tagsAvailable(app))) {
		test.skip(
			true,
			"GET /mp3/tags 404s on the deployed streamer (this branch's backend isn't deployed yet) " +
				"— FilterTree shows 'Tags unavailable.' with no checkboxes, so the Aircraft row never " +
				"renders either. Self-resolves once the backend ships; not fixable from the frontend.",
		);
	}

	const totalCards = () => app.locator("[data-item]").count();
	await expect.poll(totalCards, { timeout: 30_000 }).toBeGreaterThan(0);
	const before = await totalCards();

	// "aircraft" is one of tagFilter's LARGE_NAMESPACES — its row is a door to
	// a searchable picker window, not an inline checkbox (FilterTree.tsx).
	const filterGroup = app.getByRole("group", { name: "Tag filters" });
	await filterGroup.getByRole("button", { name: /^Aircraft/ }).click();

	const picker = page.getByRole("application", { name: "Aircraft" });
	await expect(picker).toBeVisible();
	const pickerList = picker.getByRole("group", { name: "Aircraft", exact: true });

	// Read the first real (non-empty-label) option straight off the unfiltered
	// list — no assumption about the corpus' actual aircraft vocabulary.
	const options = pickerList.locator('input[type="checkbox"]');
	await expect(options.first()).toBeVisible({ timeout: 15_000 });
	const optionCount = await options.count();
	let optionId: string | null = null;
	let optionLabel = "";
	for (let i = 0; i < optionCount; i++) {
		const candidate = options.nth(i);
		const id = await candidate.getAttribute("id");
		const text = (await picker.locator(`label[for="${id}"]`).textContent())?.trim() ?? "";
		if (text.length > 0) {
			optionId = id;
			optionLabel = text;
			break;
		}
	}
	expect(optionId, "the aircraft vocabulary has at least one labelled value").not.toBeNull();

	// Type a real prefix of that value — tagSearch.ts ranks prefix matches
	// first and matches case-insensitively — and confirm it is still offered.
	const query = optionLabel.slice(0, Math.min(3, optionLabel.length));
	await picker.getByLabel("Search").fill(query);
	const matched = picker.locator(`[id="${optionId}"]`);
	await expect(matched).toBeVisible({ timeout: 5_000 });
	await matched.check();

	await picker.getByRole("button", { name: "Confirm" }).click();
	await expect(picker).toHaveCount(0);

	// matchesFilter ANDs across namespaces (tagFilter.ts): naming one specific
	// aircraft can only narrow the set further from the fully unfiltered
	// baseline above.
	await expect.poll(totalCards, { timeout: 15_000 }).toBeLessThan(before);
});
