import type { HCAction, HCStack } from "classicy";

// Plugin-command actions (a registered `do` name like our `setDateTime`) are
// deliberately outside the typed HCAction union — stacks are normally untyped
// JSON and the engine handles unknown `do`s in its default case. Authoring the
// stack as a typed literal, we cast the command action back to HCAction.
const setDateTime = (to: string): HCAction =>
	({ do: "setDateTime", to }) as unknown as HCAction;

/**
 * A built-in HyperCard stack demonstrating the news/pager embeds and the
 * `setDateTime` action. The intro card's buttons seek the desktop's virtual
 * clock to key moments (the action clamps into the 09-09…09-12 range); the
 * later cards embed a news article and a pager message.
 *
 * The `itemId`s below are PLACEHOLDERS (1) pending real `news_items` /
 * `pager_items` ids; the parts fetch on render and degrade gracefully.
 */

export const NEWS_PAGER_STACK_ID = "directus-news-pager";

export const newsPagerStack: HCStack = {
	name: "News & Pager",
	version: "2",
	size: [420, 320],
	backgrounds: [
		{
			id: "main",
			parts: [
				{
					id: "footer",
					type: "label",
					shared: true,
					rect: [12, 292, 396, 20],
					content: "news_items + pager_items + the setDateTime action — Directus HyperCard extensions",
				},
			],
		},
	],
	cards: [
		{
			id: "intro",
			name: "Set the Clock",
			background: "main",
			parts: [
				{
					id: "introTitle",
					type: "label",
					rect: [12, 16, 396, 24],
					content: "Jump the desktop clock",
				},
				{
					id: "introText",
					type: "field",
					rect: [12, 48, 396, 52],
					locked: true,
					content:
						"These buttons run the setDateTime action, seeking every app on the desktop to that moment. Then page through a news story and a pager message.",
				},
				{
					id: "jump846",
					type: "button",
					name: "8:46 AM — Flight 11",
					rect: [12, 112, 190, 28],
					script: { onMouseUp: [setDateTime("2001-09-11T12:46:00")] },
				},
				{
					id: "jump903",
					type: "button",
					name: "9:03 AM — Flight 175",
					rect: [214, 112, 190, 28],
					script: { onMouseUp: [setDateTime("2001-09-11T13:03:00")] },
				},
				{
					id: "introNext",
					type: "button",
					name: "Next →",
					rect: [304, 154, 104, 28],
					script: {
						onMouseUp: [
							{ do: "visual", effect: "dissolve" },
							{ do: "go", to: "next" },
						],
					},
				},
			],
		},
		{
			id: "news",
			name: "News",
			background: "main",
			parts: [
				{
					id: "newsArticle",
					type: "directusNews",
					rect: [12, 12, 396, 232],
					options: { itemId: 1 },
				},
				{
					id: "newsPrev",
					type: "button",
					name: "← Prev",
					rect: [12, 252, 104, 28],
					script: {
						onMouseUp: [
							{ do: "visual", effect: "wipeRight" },
							{ do: "go", to: "prev" },
						],
					},
				},
				{
					id: "newsNext",
					type: "button",
					name: "Next →",
					rect: [304, 252, 104, 28],
					script: {
						onMouseUp: [
							{ do: "visual", effect: "wipeLeft" },
							{ do: "go", to: "next" },
						],
					},
				},
			],
		},
		{
			id: "pager",
			name: "Pager",
			background: "main",
			parts: [
				{
					id: "pagerTitle",
					type: "label",
					rect: [12, 14, 396, 22],
					content: "A pager message",
				},
				{
					id: "pagerMsg",
					type: "directusPager",
					rect: [12, 40, 396, 150],
					options: { itemId: 1 },
				},
				{
					id: "pagerPrev",
					type: "button",
					name: "← Prev",
					rect: [12, 252, 104, 28],
					script: {
						onMouseUp: [
							{ do: "visual", effect: "wipeRight" },
							{ do: "go", to: "prev" },
						],
					},
				},
			],
		},
	],
};
