import type { HCAction, HCStack } from "classicy";

/**
 * A built-in HyperCard stack demonstrating the news/pager embeds and the
 * `setDateTime` action. The intro card's buttons seek the desktop's virtual
 * clock to key moments (the action clamps into the 09-09…09-12 range); the
 * news and pager cards step through real `news_items` (5–13) and `pager_items`
 * (323–328) rows via a stack variable.
 */

// Plugin-command actions (a registered `do` name like our `setDateTime`) are
// deliberately outside the typed HCAction union — stacks are normally untyped
// JSON and the engine handles unknown `do`s in its default case. Authoring the
// stack as a typed literal, we cast the command action back to HCAction.
const setDateTime = (to: string): HCAction =>
	({ do: "setDateTime", to }) as unknown as HCAction;

export const NEWS_PAGER_STACK_ID = "directus-news-pager";

const NEWS_MIN = 5;
const NEWS_MAX = 13;
const PAGER_MIN = 323;
const PAGER_MAX = 328;

export const newsPagerStack: HCStack = {
	name: "News & Pager",
	version: "2",
	size: [420, 320],
	variables: { newsId: String(NEWS_MIN), pagerId: String(PAGER_MIN) },
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
						"These buttons run the setDateTime action, seeking every app on the desktop to that moment. Then page through news stories and pager messages.",
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
					name: "News →",
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
					id: "newsTitle",
					type: "label",
					rect: [12, 12, 396, 20],
					content: "News items 5–13",
				},
				{
					id: "newsArticle",
					type: "directusNews",
					rect: [12, 36, 396, 200],
					options: { itemId: "newsId" },
				},
				{
					id: "newsPrev",
					type: "button",
					name: "◀",
					rect: [12, 244, 60, 26],
					script: {
						onMouseUp: [
							{
								do: "if",
								condition: `newsId > ${NEWS_MIN}`,
								then: [{ do: "subtract", value: "1", var: "newsId" }],
							},
						],
					},
				},
				{
					id: "newsNext",
					type: "button",
					name: "▶",
					rect: [80, 244, 60, 26],
					script: {
						onMouseUp: [
							{
								do: "if",
								condition: `newsId < ${NEWS_MAX}`,
								then: [{ do: "add", value: "1", var: "newsId" }],
							},
						],
					},
				},
				{
					id: "newsToPager",
					type: "button",
					name: "Pager →",
					rect: [304, 244, 104, 26],
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
					rect: [12, 12, 396, 20],
					content: "Pager messages 323–328",
				},
				{
					id: "pagerMsg",
					type: "directusPager",
					rect: [12, 36, 396, 200],
					options: { itemId: "pagerId" },
				},
				{
					id: "pagerPrev",
					type: "button",
					name: "◀",
					rect: [12, 244, 60, 26],
					script: {
						onMouseUp: [
							{
								do: "if",
								condition: `pagerId > ${PAGER_MIN}`,
								then: [{ do: "subtract", value: "1", var: "pagerId" }],
							},
						],
					},
				},
				{
					id: "pagerNext",
					type: "button",
					name: "▶",
					rect: [80, 244, 60, 26],
					script: {
						onMouseUp: [
							{
								do: "if",
								condition: `pagerId < ${PAGER_MAX}`,
								then: [{ do: "add", value: "1", var: "pagerId" }],
							},
						],
					},
				},
				{
					id: "pagerToNews",
					type: "button",
					name: "← News",
					rect: [304, 244, 104, 26],
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
