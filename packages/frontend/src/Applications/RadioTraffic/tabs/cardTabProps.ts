import type {
	ItemMeta,
	MediaItem,
} from "../../../Providers/MediaStream/MediaStreamContext";

/**
 * What every card tab panel is handed.
 *
 * One shape for all five so the card can render whichever tab is active from a
 * single table of components rather than a switch that grows a branch per
 * panel. Individual panels ignore what they do not need — Transcript never
 * reads `meta`, Details never reads `currentTimeSec` — which is cheaper than
 * five near-identical prop types that drift.
 */
export interface CardTabProps {
	item: MediaItem;
	/**
	 * The item's entry in the mp3_meta frame, or undefined when it has none.
	 * 59 of the 814 mp3 items have no `parties` at all, so this is absent for
	 * 7% of the corpus and every panel must paint without it.
	 */
	meta?: ItemMeta;
	/**
	 * The desktop's display timezone offset in hours (-4 on 2001-09-11).
	 * Required rather than defaulted: there is no offset that is right when the
	 * caller forgets, and the clip's wall-clock time is the point of the panel.
	 */
	tzOffsetHours: number;
	/** Where the <audio> element is, in seconds. Transcript picks its cue by it. */
	currentTimeSec?: number;
}
