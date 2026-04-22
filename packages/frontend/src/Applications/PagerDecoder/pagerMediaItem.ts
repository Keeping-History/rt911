import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import type { CompletedLine } from "./usePagerPlayback";

let _seq = Date.now();
export const nextPagerItemId = () => ++_seq;

export function completedLineToPagerMediaItem(
	line: CompletedLine,
	id: number,
): MediaItem {
	const r = line.record;
	const isoTimestamp = r.timestamp.replace(" ", "T");
	return {
		id,
		title: r.message.length > 100 ? r.message.slice(0, 100) : r.message,
		full_title: r.message,
		source: r.provider,
		start_date: isoTimestamp,
		end_date: isoTimestamp,
		format: "pager",
		url: "",
		approved: 1,
		mute: 0,
		volume: 1,
		jump: 0,
		trim: 0,
		content: JSON.stringify({
			provider: r.provider,
			recipient_id: r.recipient_id,
			id_type: r.id_type,
			channel: r.channel,
			mode: r.mode,
			timestamp: r.timestamp,
		}),
	};
}
