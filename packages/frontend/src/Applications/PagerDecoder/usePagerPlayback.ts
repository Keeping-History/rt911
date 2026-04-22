import { useContext, useEffect, useRef, useState } from "react";
import { MediaStreamContext } from "../../Providers/MediaStream/MediaStreamContext";
import type { PagerDecoderSettings } from "./PagerDecoderContext";
import { DEFAULT_PAGER_SETTINGS } from "./PagerDecoderContext";
import type { PagerRecord } from "./pagerUtils";
import { matchesFilter } from "./pagerUtils";

export interface CompletedLine {
	id: string;
	timeKey: string;
	provider: string;
	text: string;
	record: PagerRecord;
}

export interface PlaybackState {
	lines: CompletedLine[];
	streamingText: string;
	streamingMeta: { timeKey: string; provider: string } | null;
	uniqueValues: { provider: string[]; id_type: string[]; channel: string[] };
}

/** Extract the original ET HH:MM:SS from a UTC ISO timestamp.
 *  Pager data was recorded in EDT (UTC-4). */
function utcIsoToETTimeKey(isoUtc: string): string {
	const utcMs = new Date(isoUtc).getTime();
	const edtMs = utcMs - 4 * 3600 * 1000;
	const d = new Date(edtMs);
	const h = String(d.getUTCHours()).padStart(2, "0");
	const m = String(d.getUTCMinutes()).padStart(2, "0");
	const s = String(d.getUTCSeconds()).padStart(2, "0");
	return `${h}:${m}:${s}`;
}

/** Convert a pager MediaItem's content JSON + top-level fields to a PagerRecord. */
function mediaItemToPagerRecord(item: {
	start_date: string;
	full_title: string;
	source?: string;
	content?: string;
}): PagerRecord | null {
	if (!item.full_title) return null;
	let meta: { recipient_id?: string; id_type?: string; channel?: string; mode?: string; timestamp?: string } = {};
	try {
		if (item.content) meta = JSON.parse(item.content) as typeof meta;
	} catch {
		// malformed content — use defaults
	}
	return {
		timestamp: meta.timestamp ?? item.start_date,
		provider:  item.source     ?? "",
		recipient_id: meta.recipient_id ?? "",
		id_type:      meta.id_type      ?? "",
		channel:      meta.channel      ?? "",
		mode:         meta.mode         ?? "ALPHA",
		message:      item.full_title,
	};
}

interface StreamingItem {
	record: PagerRecord;
	timeKey: string;
}

export function usePagerPlayback(
	settings: PagerDecoderSettings = DEFAULT_PAGER_SETTINGS,
	paused = false,
): PlaybackState {
	const { items, subscribeFormats, unsubscribeFormats } = useContext(MediaStreamContext);

	// Register with the MediaStream provider to receive only pager items from the server
	useEffect(() => {
		subscribeFormats("PagerDecoder.app", ["pager"]);
		return () => unsubscribeFormats("PagerDecoder.app");
	}, [subscribeFormats, unsubscribeFormats]);

	const [lines, setLines] = useState<CompletedLine[]>([]);
	const [streamingText, setStreamingText] = useState("");
	const [streamingMeta, setStreamingMeta] = useState<{
		timeKey: string;
		provider: string;
	} | null>(null);

	const queueRef       = useRef<StreamingItem[]>([]);
	const currentItemRef = useRef<StreamingItem | null>(null);
	const wordIndexRef   = useRef(0);
	const seenIdsRef     = useRef(new Set<number>());

	// Accumulate unique filter values across all received items
	const uniqueProviders = useRef(new Set<string>());
	const uniqueIdTypes   = useRef(new Set<string>());
	const uniqueChannels  = useRef(new Set<string>());
	const [uniqueValues, setUniqueValues] = useState<PlaybackState["uniqueValues"]>({
		provider: [],
		id_type:  [],
		channel:  [],
	});

	const settingsRef = useRef(settings);
	settingsRef.current = settings;
	const pausedRef = useRef(paused);
	pausedRef.current = paused;

	// Watch incoming items for new pager entries
	useEffect(() => {
		const pagerItems = items.filter((i) => i.format === "pager");
		let hasNewUnique = false;

		for (const item of pagerItems) {
			if (seenIdsRef.current.has(item.id)) continue;
			seenIdsRef.current.add(item.id);

			const record = mediaItemToPagerRecord(item);
			if (!record) continue;

			// Track unique values regardless of current filter
			if (record.provider && !uniqueProviders.current.has(record.provider)) {
				uniqueProviders.current.add(record.provider);
				hasNewUnique = true;
			}
			if (record.id_type && !uniqueIdTypes.current.has(record.id_type)) {
				uniqueIdTypes.current.add(record.id_type);
				hasNewUnique = true;
			}
			if (record.channel && !uniqueChannels.current.has(record.channel)) {
				uniqueChannels.current.add(record.channel);
				hasNewUnique = true;
			}

			if (!matchesFilter(record, settingsRef.current.filter)) continue;

			queueRef.current.push({
				record,
				timeKey: utcIsoToETTimeKey(item.start_date),
			});
		}

		if (hasNewUnique) {
			setUniqueValues({
				provider: [...uniqueProviders.current].sort(),
				id_type:  [...uniqueIdTypes.current].sort(),
				channel:  [...uniqueChannels.current].sort(),
			});
		}
	}, [items]);

	// Stream tick: advance one word every ms
	useEffect(() => {
		const streamId = setInterval(() => {
			if (pausedRef.current) return;

			if (!currentItemRef.current) {
				const next = queueRef.current.shift();
				if (!next) return;
				currentItemRef.current = next;
				wordIndexRef.current = 0;
				setStreamingMeta({ timeKey: next.timeKey, provider: next.record.provider });
				setStreamingText("");
			}

			const item  = currentItemRef.current;
			const words = item.record.message.split(" ");
			wordIndexRef.current += 1;
			const partial = words.slice(0, wordIndexRef.current).join(" ");
			setStreamingText(partial);

			if (wordIndexRef.current >= words.length) {
				const completed: CompletedLine = {
					id:       `${item.timeKey}-${item.record.recipient_id}-${Date.now()}`,
					timeKey:  item.timeKey,
					provider: item.record.provider,
					text:     item.record.message,
					record:   item.record,
				};
				const retention = settingsRef.current.retentionLines;
				setLines((prev) => {
					const next = [...prev, completed];
					return retention > 0 ? next.slice(-retention) : next;
				});
				setStreamingText("");
				setStreamingMeta(null);
				currentItemRef.current = null;
				wordIndexRef.current = 0;
			}
		}, 1);

		return () => clearInterval(streamId);
	}, []);

	return { lines, streamingText, streamingMeta, uniqueValues };
}
