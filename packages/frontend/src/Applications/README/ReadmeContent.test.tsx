import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { formatArticleDate, ReadmeContent } from "./ReadmeContent";
import type { ReadmeArticle, ReadmeArticlesState } from "./useReadmeArticles";

afterEach(cleanup);

const ARTICLES: ReadmeArticle[] = [
	{
		id: 2, headline: "Newer post", author: "Robbie Byrd",
		date_created: "2026-07-16T12:00:00", date_updated: null, body: "<p>Two</p>",
		sort: null, featured: false, tags: [],
	},
	{
		id: 1, headline: "Welcome", author: null,
		date_created: "2026-07-01T12:00:00", date_updated: null, body: "<p>One</p>",
		sort: null, featured: false, tags: [],
	},
];

function stateWith(overrides: Partial<ReadmeArticlesState>): ReadmeArticlesState {
	return { articles: [], loading: false, error: null, ...overrides };
}

describe("formatArticleDate", () => {
	it("formats an ISO date as a short US date", () => {
		expect(formatArticleDate("2026-07-16T12:00:00")).toBe("Jul 16, 2026");
	});
});

describe("ReadmeContent", () => {
	it("shows a loading state", () => {
		render(<ReadmeContent state={stateWith({ loading: true })} />);
		expect(screen.getByText("Loading…")).toBeDefined();
	});

	it("shows the error state when nothing loaded", () => {
		render(<ReadmeContent state={stateWith({ error: "HTTP 500" })} />);
		expect(screen.getByText(/Couldn’t load articles/)).toBeDefined();
	});

	it("shows an empty state when there are no articles", () => {
		render(<ReadmeContent state={stateWith({})} />);
		expect(screen.getByText("No articles yet.")).toBeDefined();
	});

	it("lists headline, author and date for every article", () => {
		render(<ReadmeContent state={stateWith({ articles: ARTICLES })} />);
		// The selected article's headline appears in both the list and the body,
		// so it matches more than once.
		expect(screen.getAllByText("Newer post").length).toBeGreaterThan(0);
		expect(screen.getByText("Robbie Byrd — Jul 16, 2026")).toBeDefined();
		expect(screen.getByText("Welcome")).toBeDefined();
		expect(screen.getByText("Jul 1, 2026")).toBeDefined(); // authorless byline
	});

	it("repeats the selected article's headline in the reading pane", () => {
		const { container } = render(<ReadmeContent state={stateWith({ articles: ARTICLES })} />);
		// Default selection is the newest article; its headline heads the body.
		expect(container.querySelector("article h1")?.textContent).toBe("Newer post");
	});

	it("shows a star only next to featured articles", () => {
		const mixed: ReadmeArticle[] = [
			{
				id: 5, headline: "Pinned", author: null,
				date_created: "2026-07-20T00:00:00", date_updated: null, body: "<p>x</p>",
				sort: null, featured: true, tags: [],
			},
			{
				id: 6, headline: "Plain", author: null,
				date_created: "2026-07-19T00:00:00", date_updated: null, body: "<p>y</p>",
				sort: null, featured: false, tags: [],
			},
		];
		render(<ReadmeContent state={stateWith({ articles: mixed })} />);
		// One star: the featured row. The plain row has none.
		expect(screen.getAllByAltText("Featured").length).toBe(1);
	});

	it("selects the newest article by default and swaps the body on click", () => {
		const { container } = render(<ReadmeContent state={stateWith({ articles: ARTICLES })} />);
		const body = () => container.querySelector("article");
		expect(body()?.innerHTML).toContain("Two");

		fireEvent.click(screen.getByText("Welcome"));
		expect(body()?.innerHTML).toContain("One");
	});

	it("sanitizes the article body", () => {
		const evil: ReadmeArticle = {
			id: 9, headline: "XSS", author: null,
			date_created: "2026-07-16T12:00:00", date_updated: null,
			body: '<p>safe</p><script>window.__pwned = true</script><img src="x" onerror="window.__pwned = true">',
			sort: null, featured: false, tags: [],
		};
		const { container } = render(<ReadmeContent state={stateWith({ articles: [evil] })} />);
		const article = container.querySelector("article");
		expect(article?.textContent).toContain("safe");
		expect(article?.querySelector("script")).toBeNull();
		expect(article?.querySelector("img")?.getAttribute("onerror")).toBeNull();
	});
});
