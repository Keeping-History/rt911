import type React from "react";
import { useEffect, useState } from "react";
import { vttUrl } from "../../../Providers/MediaStream/MediaStreamContext";
import type { CardTabProps } from "./cardTabProps";
import styles from "./cardTabs.module.scss";
import { activeCueIndex, parseTranscriptCues, type TranscriptCue } from "./transcriptCues";

/**
 * What was said on the clip — the whole transcript, with the cue at the
 * playhead marked when there is a playhead.
 *
 * It shows the whole thing rather than only the active cue because a card is
 * almost never playing. `TrafficCard` derives `currentTimeSec` from
 * `audioCoordinator.positionMs`, which returns undefined for any item with no
 * registered <audio> element — every UPCOMING card, every PREVIOUS card the
 * listener has not started, and every LIVE card before its element loads. A
 * panel keyed to the playhead is therefore blank on most of the wall, which is
 * exactly the bug this replaced: the previous version asked classicy for the
 * cue at second 0 and got nothing, because that hook matches cues with two
 * strict comparisons and the first cue of a real clip starts at 0.8s.
 *
 * The trade this makes is height: a long clip is a long panel, and the card
 * grows to fit it (see .rtCardPanel). That is the specified behaviour — panels
 * size to content and a row levels up to its tallest — but it does mean the
 * Transcript tab is the one that decides how tall its row is.
 */

/** What the panel knows about its transcript at any moment. */
type TranscriptState =
	| { status: "none" }
	| { status: "loading" }
	| { status: "ready"; cues: TranscriptCue[] }
	| { status: "error" };

/**
 * Fetch and parse the clip's VTT.
 *
 * Own fetch rather than classicy's hook because classicy exposes no cue list —
 * see transcriptCues.ts. Aborts on url change so a card scrolling through the
 * lane cannot land a stale transcript on the wrong clip.
 */
function useTranscript(url: string | undefined): TranscriptState {
	const [state, setState] = useState<TranscriptState>({ status: "none" });

	useEffect(() => {
		if (!url) {
			setState({ status: "none" });
			return;
		}
		setState({ status: "loading" });
		const controller = new AbortController();
		fetch(url, { signal: controller.signal })
			.then((response) => {
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				return response.text();
			})
			.then((body) => setState({ status: "ready", cues: parseTranscriptCues(body) }))
			.catch((error: unknown) => {
				// An abort is this effect cleaning up after itself, not a failure —
				// reporting it would flash "unavailable" on every re-render.
				if (error instanceof Error && error.name === "AbortError") return;
				setState({ status: "error" });
			});
		return () => controller.abort();
	}, [url]);

	return state;
}

/** The panel's message when there are no cues to show, or null when there are. */
function emptyState(state: TranscriptState): { key: string; text: string } | null {
	switch (state.status) {
		case "none":
			return { key: "none", text: "No transcript." };
		case "loading":
			return { key: "loading", text: "Loading transcript…" };
		case "error":
			return { key: "error", text: "Transcript unavailable." };
		case "ready":
			return state.cues.length === 0 ? { key: "empty", text: "Transcript is empty." } : null;
	}
}

export const TranscriptTab: React.FC<CardTabProps> = ({ item, currentTimeSec }) => {
	// `vttUrl` derives the .vtt sibling of the .srt the wire carries. Both exist
	// on the CDN — the .vtt for this clip's .srt returns 200 text/vtt (checked
	// against files.911realtime.org, 2026-08-18) — so a missing transcript here
	// is an item with no `subtitles` at all, not a gap in the pipeline.
	const state = useTranscript(vttUrl(item.subtitles));
	const cues = state.status === "ready" ? state.cues : [];
	const active = activeCueIndex(cues, currentTimeSec);
	const empty = emptyState(state);

	return (
		<div className={styles.rtTabPanel} data-tab="transcript">
			{empty ? (
				<p className={styles.rtEmpty} data-state={empty.key}>
					{empty.text}
				</p>
			) : (
				<ol className={styles.rtCueList} data-state="cues">
					{cues.map((cue, index) => (
						<li
							// Cues are positional and two can legitimately carry the same
							// text ("Roger."), so the index is the only stable key.
							// biome-ignore lint/suspicious/noArrayIndexKey: cues have no id
							key={index}
							className={styles.rtCueLine}
							data-cue={index}
							data-active={index === active ? "true" : undefined}
						>
							{cue.text}
						</li>
					))}
				</ol>
			)}
		</div>
	);
};
