// Test-only builders for the five card tab panels. Not imported by any app
// module, so it never reaches the bundle — it lives beside the panels rather
// than in a test file because all five suites plus the no-metadata suite need
// the same two shapes, and six hand-copied factories drift.

import type {
	ItemMeta,
	MediaItem,
} from "../../../Providers/MediaStream/MediaStreamContext";

/** A wire-shaped mp3 item; override only what a test actually asserts on. */
export function makeItem(overrides: Partial<MediaItem> = {}): MediaItem {
	return {
		id: 1,
		title: "ZBW",
		full_title: "Boston Center — sector 20",
		source: "ATC",
		start_date: "2001-09-11 12:46:31",
		end_date: "2001-09-11 12:49:44",
		url: "https://files.example/clip.mp3",
		format: "mp3",
		approved: 1,
		mute: 0,
		volume: 1,
		jump: 0,
		trim: 0,
		subtitles: "https://files.example/clip.srt",
		...overrides,
	};
}

/** A fully-populated ItemMeta, as the mp3_meta frame carries it. */
export function makeMeta(overrides: Partial<ItemMeta> = {}): ItemMeta {
	return {
		subject: "Boston Center loses contact with American 11",
		link: "ZBW ↔ AAL11",
		tier: "primary",
		confidence: "high",
		participants: [
			{ person: "Pete Zalewski", facility: "ZBW", role: "controller", confidence: "high" },
			{ person: "John Ogonowski", facility: "AAL11", role: "pilot", confidence: "medium" },
		],
		mentions: {
			facilities: ["ZNY", "Otis ANGB"],
			aircraft: ["UAL175"],
			people: ["Betty Ong"],
		},
		provenance: {
			generated_at: "2026-08-14T09:12:00Z",
			sources: { subject: "transcript" },
			commission: { title: "9/11 Commission Report", source: "NARA", stamp: "ch.1 n.44" },
		},
		tags: [
			{ tag: "topic:hijacking", namespace: "topic", value: "Hijacking" },
			{ tag: "facility:zbw", namespace: "facility", value: "ZBW" },
			{ tag: "aircraft:aal11", namespace: "aircraft", value: "AAL11" },
		],
		...overrides,
	};
}
