import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ItemMeta } from "../../../Providers/MediaStream/MediaStreamContext";

// The transcript panel is the only one that goes to the network; stub it so
// this suite is about the metadata gap, not about fetching a VTT. It answers
// with a real transcript because the point being made is that a clip with no
// metadata still has one — the transcript lives on the item, not in mp3_meta.
vi.stubGlobal(
	"fetch",
	vi.fn(async () => ({
		ok: true,
		status: 200,
		text: async () => "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBoston Center.\n",
	})),
);

import { makeItem } from "./cardTabFixtures";
import { DetailsTab } from "./DetailsTab";
import { MentionsTab } from "./MentionsTab";
import { PartiesTab } from "./PartiesTab";
import { SourceTab } from "./SourceTab";
import { SummaryTab } from "./SummaryTab";
import { TranscriptTab } from "./TranscriptTab";

afterEach(cleanup);

// Summary is in this list even though the card hides that tab for an item with
// no summary: the panel is a component like the other five, and the guarantee
// being made here is that none of them can paint an empty box.
const PANELS = [
	["Details", DetailsTab],
	["Summary", SummaryTab],
	["Mentions", MentionsTab],
	["Parties", PartiesTab],
	["Transcript", TranscriptTab],
	["Source", SourceTab],
] as const;

/**
 * 59 of the 814 mp3 items have no `parties` at all, so their id is simply
 * absent from the mp3_meta frame. That is 7% of the corpus, not an edge case:
 * every panel has to paint something for them.
 *
 * The three shapes below are the three ways "no metadata" actually reaches a
 * panel — the id was never in the frame, the derivation ran and produced
 * nothing, and the derivation wrote the keys but left them empty.
 */
const NO_METADATA: [string, ItemMeta | undefined][] = [
	["absent from the mp3_meta frame", undefined],
	["present but derived from no parties", {}],
	["present with every field emptied", {
		subject: undefined,
		link: undefined,
		participants: [],
		mentions: { facilities: [], aircraft: [], people: [] },
		provenance: undefined,
		tags: [],
	}],
];

describe("card tab panels, for an item with no metadata", () => {
	for (const [shape, meta] of NO_METADATA) {
		for (const [name, Panel] of PANELS) {
			it(`renders ${name} for an item ${shape}`, () => {
				const { container } = render(
					<Panel item={makeItem()} meta={meta} tzOffsetHours={-4} />,
				);
				// Not merely "did not throw": a panel that renders an empty box
				// is a card with a dead tab, so each must say something.
				expect(container.textContent?.trim().length).toBeGreaterThan(0);
			});
		}
	}
});
