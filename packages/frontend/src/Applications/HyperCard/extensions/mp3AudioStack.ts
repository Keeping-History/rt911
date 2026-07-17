import type { HCStack } from "classicy";

/**
 * A built-in HyperCard stack that demonstrates the `directusAudio` extension
 * part: each card embeds one audio clip from the `mp3_items` Directus
 * collection, alongside the ordinary HyperCard parts (labels, buttons,
 * navigation). Registered with the app via `registerHyperCardStack`, so it
 * shows up in HyperCard's File → Open menu.
 *
 * The `itemId`s below (9, 197, 36) reference rows in the live `mp3_items`
 * collection; the part fetches each on render and degrades gracefully (a
 * "Could not load audio" note) if an id is absent. The final card resolves its
 * id from a stack variable so its buttons can switch between the same clips.
 */

/** The audio-part `type` string this stack embeds — must match the registered part. */
export const DIRECTUS_AUDIO_PART_TYPE = "directusAudio";

/** Stable id used both in the File menu registry and as the stack source key. */
export const MP3_AUDIO_STACK_ID = "directus-mp3-audio";

export const mp3AudioStack: HCStack = {
	name: "Audio Clips",
	version: "2",
	size: [420, 300],
	variables: { clip: "9" },
	backgrounds: [
		{
			id: "main",
			parts: [
				{
					id: "footer",
					type: "label",
					shared: true,
					rect: [16, 272, 388, 20],
					content: "Audio from the mp3_items collection — a Directus HyperCard extension",
				},
			],
		},
	],
	cards: [
		{
			id: "intro",
			name: "Audio Clips",
			background: "main",
			parts: [
				{
					id: "introTitle",
					type: "label",
					rect: [16, 16, 388, 24],
					content: "Directus Audio",
				},
				{
					id: "introText",
					type: "field",
					rect: [16, 48, 388, 56],
					locked: true,
					content:
						"Each card embeds an audio clip pulled live from the mp3_items collection. Click Next to hear the first clip.",
				},
				{
					id: "introNext",
					type: "button",
					name: "Next →",
					rect: [304, 130, 100, 28],
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
			id: "clip-1",
			name: "Clip One",
			background: "main",
			parts: [
				{
					id: "clip1Title",
					type: "label",
					rect: [16, 16, 388, 24],
					content: "Clip #9",
				},
				{
					id: "clip1Audio",
					type: DIRECTUS_AUDIO_PART_TYPE,
					rect: [16, 52, 388, 96],
					options: { itemId: 9 },
				},
				{
					id: "clip1Prev",
					type: "button",
					name: "← Prev",
					rect: [16, 160, 100, 28],
					script: {
						onMouseUp: [
							{ do: "visual", effect: "wipeRight" },
							{ do: "go", to: "prev" },
						],
					},
				},
				{
					id: "clip1Next",
					type: "button",
					name: "Next →",
					rect: [304, 160, 100, 28],
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
			id: "clip-2",
			name: "Clip Two",
			background: "main",
			parts: [
				{
					id: "clip2Title",
					type: "label",
					rect: [16, 16, 388, 24],
					content: "Clip #197",
				},
				{
					id: "clip2Audio",
					type: DIRECTUS_AUDIO_PART_TYPE,
					rect: [16, 52, 388, 96],
					options: { itemId: 197 },
				},
				{
					id: "clip2Prev",
					type: "button",
					name: "← Prev",
					rect: [16, 160, 100, 28],
					script: {
						onMouseUp: [
							{ do: "visual", effect: "wipeRight" },
							{ do: "go", to: "prev" },
						],
					},
				},
				{
					id: "clip2Next",
					type: "button",
					name: "Next →",
					rect: [304, 160, 100, 28],
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
			id: "clip-3",
			name: "Clip Three",
			background: "main",
			parts: [
				{
					id: "clip3Title",
					type: "label",
					rect: [16, 16, 388, 24],
					content: "Clip #36",
				},
				{
					id: "clip3Audio",
					type: DIRECTUS_AUDIO_PART_TYPE,
					rect: [16, 52, 388, 96],
					options: { itemId: 36 },
				},
				{
					id: "clip3Prev",
					type: "button",
					name: "← Prev",
					rect: [16, 160, 100, 28],
					script: {
						onMouseUp: [
							{ do: "visual", effect: "wipeRight" },
							{ do: "go", to: "prev" },
						],
					},
				},
				{
					id: "clip3Next",
					type: "button",
					name: "Next →",
					rect: [304, 160, 100, 28],
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
			id: "chosen",
			name: "By Variable",
			background: "main",
			parts: [
				{
					id: "chosenTitle",
					type: "label",
					rect: [16, 16, 388, 24],
					content: "Pick a clip by id",
				},
				{
					id: "chosenAudio",
					// itemId resolves through the expression engine, so it can
					// track a stack variable set by the buttons below.
					type: DIRECTUS_AUDIO_PART_TYPE,
					rect: [16, 52, 388, 96],
					options: { itemId: "clip" },
				},
				{
					id: "chosenOne",
					type: "button",
					name: "#9",
					rect: [16, 160, 60, 28],
					script: { onMouseUp: [{ do: "put", value: "9", var: "clip" }] },
				},
				{
					id: "chosenTwo",
					type: "button",
					name: "#197",
					rect: [84, 160, 60, 28],
					script: { onMouseUp: [{ do: "put", value: "197", var: "clip" }] },
				},
				{
					id: "chosenThree",
					type: "button",
					name: "#36",
					rect: [152, 160, 60, 28],
					script: { onMouseUp: [{ do: "put", value: "36", var: "clip" }] },
				},
				{
					id: "chosenPrev",
					type: "button",
					name: "← Prev",
					rect: [304, 160, 100, 28],
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
