import type { HCStack } from "classicy";

/**
 * A built-in HyperCard stack that demonstrates the TV video extensions:
 * `directusVideo` (a single channel, optionally limited to a start/end segment,
 * with controls/autoplay/loop/captions) and `directusMultiview` (a grid of
 * channels — a "video wall"). Registered with the app via
 * `registerHyperCardStack`, so it appears in HyperCard's File → Open menu.
 *
 * The `channelId`s below (3, 6, 23) reference rows in the live `tv_channels`
 * collection; the parts fetch each on render and degrade gracefully (a "Could
 * not load video" note) if an id is absent.
 */

export const DIRECTUS_VIDEO_PART_TYPE = "directusVideo";
export const DIRECTUS_MULTIVIEW_PART_TYPE = "directusMultiview";

/** Stable id used both in the File menu registry and as the stack source key. */
export const TV_CHANNEL_STACK_ID = "directus-tv-channels";

export const tvChannelStack: HCStack = {
	name: "TV Channels",
	version: "2",
	size: [440, 340],
	backgrounds: [
		{
			id: "main",
			parts: [
				{
					id: "footer",
					type: "label",
					shared: true,
					rect: [12, 312, 416, 20],
					content: "TV from the tv_channels collection — a Directus HyperCard extension",
				},
			],
		},
	],
	cards: [
		{
			id: "intro",
			name: "TV Channels",
			background: "main",
			parts: [
				{
					id: "introTitle",
					type: "label",
					rect: [12, 16, 416, 24],
					content: "Directus TV",
				},
				{
					id: "introText",
					type: "field",
					rect: [12, 48, 416, 90],
					locked: true,
					content:
						"These cards embed live TV channel streams from the tv_channels collection: a single channel limited to a segment, an autoplaying looped segment, and a multiview video wall. Click Next to begin.",
				},
				{
					id: "introNext",
					type: "button",
					name: "Next →",
					rect: [324, 150, 104, 28],
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
			id: "single",
			name: "Single Channel",
			background: "main",
			parts: [
				{
					id: "singleTitle",
					type: "label",
					rect: [12, 14, 416, 22],
					content: "Channel #3 — controls + captions, seconds 60–180",
				},
				{
					id: "singleVideo",
					type: DIRECTUS_VIDEO_PART_TYPE,
					rect: [12, 40, 416, 232],
					options: {
						channelId: 3,
						start: 60,
						end: 180,
						controls: true,
						captions: true,
						overlay: true,
					},
				},
				{
					id: "singlePrev",
					type: "button",
					name: "← Prev",
					rect: [12, 280, 104, 26],
					script: {
						onMouseUp: [
							{ do: "visual", effect: "wipeRight" },
							{ do: "go", to: "prev" },
						],
					},
				},
				{
					id: "singleNext",
					type: "button",
					name: "Next →",
					rect: [324, 280, 104, 26],
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
			id: "loop",
			name: "Looped Segment",
			background: "main",
			parts: [
				{
					id: "loopTitle",
					type: "label",
					rect: [12, 14, 416, 22],
					content: "Channel #6 — autoplay, muted, looping seconds 30–45",
				},
				{
					id: "loopVideo",
					type: DIRECTUS_VIDEO_PART_TYPE,
					rect: [12, 40, 416, 232],
					options: {
						channelId: 6,
						start: 30,
						end: 45,
						autoPlay: true,
						loop: true,
						controls: false,
						muted: true,
						overlay: true,
					},
				},
				{
					id: "loopPrev",
					type: "button",
					name: "← Prev",
					rect: [12, 280, 104, 26],
					script: {
						onMouseUp: [
							{ do: "visual", effect: "wipeRight" },
							{ do: "go", to: "prev" },
						],
					},
				},
				{
					id: "loopNext",
					type: "button",
					name: "Next →",
					rect: [324, 280, 104, 26],
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
			id: "wall",
			name: "Multiview",
			background: "main",
			parts: [
				{
					id: "wallTitle",
					type: "label",
					rect: [12, 14, 416, 22],
					content: "Multiview — tap a panel to hear its audio",
				},
				{
					id: "wallGrid",
					type: DIRECTUS_MULTIVIEW_PART_TYPE,
					rect: [12, 40, 416, 232],
					options: {
						audio: "solo",
						columns: 2,
						videos: [
							{ channelId: 3, autoPlay: true },
							{ channelId: 6, autoPlay: true },
							{ channelId: 23, autoPlay: true },
						],
					},
				},
				{
					id: "wallPrev",
					type: "button",
					name: "← Prev",
					rect: [12, 280, 104, 26],
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
