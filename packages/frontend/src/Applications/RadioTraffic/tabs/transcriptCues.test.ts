import { describe, expect, it } from "vitest";
import { activeCueIndex, parseTranscriptCues } from "./transcriptCues";

/**
 * The body below is the real shape the CDN serves: the first cue of a genuine
 * clip starts at 0.800, not at zero. That single fact is why the panel used to
 * render nothing — a card with no audio element reports no position, the panel
 * asked for second 0, and second 0 is inside no cue.
 *
 * Taken from
 * files.911realtime.org/subtitles/audio/faa_atc/clips/aa11/083619 ... .vtt
 * (fetched 2026-08-18, 200 text/vtt).
 */
const REAL_VTT = `WEBVTT

00:00:00.800 --> 00:00:02.630
You just have 583, Boston.

00:00:02.630 --> 00:00:04.760
583, go ahead.

00:00:04.760 --> 00:00:06.120
How's the visibility?
`;

describe("parseTranscriptCues", () => {
	it("reads every cue of a real VTT, in file order", () => {
		const cues = parseTranscriptCues(REAL_VTT);
		expect(cues.map((cue) => cue.text)).toEqual([
			"You just have 583, Boston.",
			"583, go ahead.",
			"How's the visibility?",
		]);
	});

	it("reads timestamps as milliseconds, treating the fraction as a decimal", () => {
		// 0.8s is 800ms, not 8ms — the bug that would put every cue at the top of
		// the clip and make the whole transcript highlight at once.
		expect(parseTranscriptCues(REAL_VTT)[0]).toMatchObject({ fromMs: 800, toMs: 2630 });
	});

	it("reads an hours field when the clip is long enough to have one", () => {
		const cues = parseTranscriptCues("WEBVTT\n\n01:02:03.004 --> 01:02:04.000\nLate.\n");
		expect(cues[0].fromMs).toBe(3_723_004);
	});

	it("reads SRT too, so a missing .vtt degrades to the file the wire carries", () => {
		// vttUrl() derives a .vtt sibling; if one is ever absent the .srt is what
		// mp3_items.subtitles actually points at, and it differs only in its
		// decimal comma.
		const cues = parseTranscriptCues("1\n00:00:01,500 --> 00:00:03,000\nRoger.\n");
		expect(cues).toEqual([{ fromMs: 1500, toMs: 3000, text: "Roger." }]);
	});

	it("joins a multi-line cue into one line, the card wrapping to its own width", () => {
		const cues = parseTranscriptCues("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBoston Center,\nAmerican 11.\n");
		expect(cues[0].text).toBe("Boston Center, American 11.");
	});

	it("skips headers, cue identifiers and NOTE blocks without inventing cues", () => {
		const cues = parseTranscriptCues(
			"WEBVTT\n\nNOTE this is a comment\nabout the clip\n\ncue-7\n00:00:01.000 --> 00:00:02.000\nOnly cue.\n",
		);
		expect(cues).toEqual([{ fromMs: 1000, toMs: 2000, text: "Only cue." }]);
	});

	it("drops cue settings that follow the end timestamp", () => {
		const cues = parseTranscriptCues(
			"WEBVTT\n\n00:00:01.000 --> 00:00:02.000 align:start line:90%\nPositioned.\n",
		);
		expect(cues).toEqual([{ fromMs: 1000, toMs: 2000, text: "Positioned." }]);
	});

	it("discards a malformed timing line without swallowing the next cue", () => {
		// The bad block's text must be consumed, not left to be read as the good
		// cue's payload — otherwise one typo corrupts the cue after it.
		const cues = parseTranscriptCues(
			"WEBVTT\n\nnot-a-time --> also-not\nGarbage.\n\n00:00:01.000 --> 00:00:02.000\nGood.\n",
		);
		expect(cues).toEqual([{ fromMs: 1000, toMs: 2000, text: "Good." }]);
	});

	it("returns nothing for an empty or non-subtitle body rather than throwing", () => {
		expect(parseTranscriptCues("")).toEqual([]);
		expect(parseTranscriptCues("<html>404 Not Found</html>")).toEqual([]);
	});

	it("handles CRLF, which is what a Windows-authored SRT carries", () => {
		const cues = parseTranscriptCues("WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nRoger.\r\n");
		expect(cues).toEqual([{ fromMs: 1000, toMs: 2000, text: "Roger." }]);
	});
});

describe("activeCueIndex", () => {
	const cues = parseTranscriptCues(REAL_VTT);

	it("finds the cue covering the playhead", () => {
		expect(activeCueIndex(cues, 3)).toBe(1);
	});

	it("includes a cue's own start instant, unlike classicy's strict comparison", () => {
		// classicy matches `from < t && to > t`, so a cue starting exactly at the
		// playhead is invisible. A clip whose first cue starts at 0.000 would
		// therefore never light up at all.
		expect(activeCueIndex(cues, 0.8)).toBe(0);
		expect(activeCueIndex(parseTranscriptCues("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nGo.\n"), 0)).toBe(0);
	});

	it("excludes a cue's end instant, so adjoining cues never both match", () => {
		// Cue 0 ends and cue 1 begins at 2.630; exactly one of them is active.
		expect(activeCueIndex(cues, 2.63)).toBe(1);
	});

	it("reports no cue for a position before, after, or between cues", () => {
		expect(activeCueIndex(cues, 0.5)).toBe(-1);
		expect(activeCueIndex(cues, 99)).toBe(-1);
	});

	it("reports no cue when the card has no playhead at all", () => {
		// The common case: audioCoordinator.positionMs returns undefined for every
		// card with no registered <audio> element, which is nearly all of them.
		expect(activeCueIndex(cues, undefined)).toBe(-1);
		expect(activeCueIndex(cues, Number.NaN)).toBe(-1);
	});
});
