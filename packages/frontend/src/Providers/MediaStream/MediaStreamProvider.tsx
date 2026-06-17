import { useClassicyDateTime } from "classicy";
import {
	type FC,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	type AvailableSources,
	MediaStreamContext,
	type MediaItem,
	type PagerItem,
} from "./MediaStreamContext";
import { decodeWireMessage } from "./wireCodec";
import { drainDue, partitionByDue } from "./revealBuffer";

// Merge incoming items into a prior list, de-duplicating by id (last write wins).
function mergeById<T extends { id: number }>(prev: T[], incoming: T[]): T[] {
	const byId = new Map(prev.map((i) => [i.id, i]));
	for (const item of incoming) byId.set(item.id, item);
	return Array.from(byId.values());
}

// Pager items are instant — retained by start_date within the instant window.
function keepPagerItem(item: PagerItem, now: number): boolean {
	return now - new Date(item.start_date).getTime() < INSTANT_RETENTION_MS;
}

// Instant items (start_date = end_date or calc_duration = 0) are kept for
// this many milliseconds after their start time before being pruned.
const INSTANT_RETENTION_MS = 10 * 60 * 1000; // 10 minutes

// Whether a media-shaped item should still be retained at wall time `now`.
// Long items live until their end_date passes; instant items linger for
// INSTANT_RETENTION_MS after their start. Shared by media `items` and `mp3Items`.
function keepMediaItem(item: MediaItem, now: number): boolean {
	if (!item.end_date) return true;
	const endMs = new Date(item.end_date).getTime();
	if (item.start_date === item.end_date || (item.calc_duration ?? -1) === 0) {
		return now - endMs < INSTANT_RETENTION_MS;
	}
	return endMs > now;
}

const WS_URL: string =
	(import.meta.env.VITE_MEDIA_STREAM_URL as string | undefined) ??
	"ws://localhost:8080/stream";

const HEARTBEAT_INTERVAL_MS = 30_000;

// Jumps larger than this are treated as manual seeks rather than clock ticks
const SEEK_THRESHOLD_MS = 90_000;

interface WsItemsMessage {
	type: "items" | "init_ack" | "seek_ack";
	items: MediaItem[];
}

interface WsPagerMessage {
	type: "pager";
	pager: PagerItem[];
}

// mp3 and news frames reuse the items field but carry a distinct type.
interface WsMp3Message {
	type: "mp3";
	items: MediaItem[];
}

interface WsNewsMessage {
	type: "news";
	items: MediaItem[];
}

interface WsSourcesMessage {
	type: "sources";
	sources: AvailableSources;
}

type WsIncomingMessage =
	| WsItemsMessage
	| WsPagerMessage
	| WsMp3Message
	| WsNewsMessage
	| WsSourcesMessage
	| { type: string };

interface MediaStreamProviderProps {
	children: ReactNode;
}

export const MediaStreamProvider: FC<MediaStreamProviderProps> = ({
	children,
}) => {
	const { localDate, dateTime } = useClassicyDateTime({ tick: true });

	const [items, setItems] = useState<MediaItem[]>([]);
	const [pagerItems, setPagerItems] = useState<PagerItem[]>([]);
	const [mp3Items, setMp3Items] = useState<MediaItem[]>([]);
	const [newsItems, setNewsItems] = useState<MediaItem[]>([]);
	const [sources, setSources] = useState<AvailableSources>({ video: [], pager: [] });
	const [connected, setConnected] = useState(false);

	// Per-app format subscriptions. null = wants all formats.
	const formatSubscriptions = useRef(new Map<string, string[] | null>());

	// Ref-counted channel subscribers. The server only delivers a channel's
	// items while at least one app is subscribed.
	const pagerSubscribers = useRef(new Set<string>());
	const mp3Subscribers = useRef(new Set<string>());
	const newsSubscribers = useRef(new Set<string>());

	// Reveal buffers: not-yet-due items from a windowed frame, keyed by id. The
	// per-second effect promotes each into live state when the virtual clock
	// reaches its start_date — this is what preserves forward-only pacing.
	const mediaBuffer = useRef(new Map<number, MediaItem>());
	const pagerBuffer = useRef(new Map<number, PagerItem>());
	const mp3Buffer = useRef(new Map<number, MediaItem>());
	const newsBuffer = useRef(new Map<number, MediaItem>());

	const addItems = useCallback((incoming: MediaItem[]) => {
		setItems((prev) => {
			const byId = new Map(prev.map((i) => [i.id, i]));
			for (const item of incoming) byId.set(item.id, item);
			return Array.from(byId.values());
		});
	}, []);

	const wsRef = useRef<WebSocket | null>(null);
	// Always-current localDate for use inside WS callbacks and intervals
	const localDateRef = useRef(localDate);
	const prevDateTimeRef = useRef(dateTime);

	useEffect(() => {
		localDateRef.current = localDate;
	}, [localDate]);

	const send = useCallback((msg: object) => {
		const ws = wsRef.current;
		if (ws?.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(msg));
		}
	}, []);

	const sendFormatFilter = useCallback(() => {
		// The server refills the media window under the new whitelist; drop buffered
		// media selected under the old filter so it can't surface.
		mediaBuffer.current.clear();
		const subs = formatSubscriptions.current;
		// If no subscriptions or any app wants all formats → no filter
		if (subs.size === 0 || [...subs.values()].some((f) => f === null)) {
			send({ type: "filter", formats: null });
			return;
		}
		const all = new Set<string>();
		for (const formats of subs.values()) {
			if (formats) for (const f of formats) all.add(f);
		}
		send({ type: "filter", formats: [...all] });
	}, [send]);

	const subscribeFormats = useCallback(
		(appId: string, formats: string[] | null) => {
			formatSubscriptions.current.set(appId, formats);
			sendFormatFilter();
		},
		[sendFormatFilter],
	);

	const unsubscribeFormats = useCallback(
		(appId: string) => {
			formatSubscriptions.current.delete(appId);
			sendFormatFilter();
		},
		[sendFormatFilter],
	);

	const subscribePager = useCallback(
		(appId: string) => {
			const wasEmpty = pagerSubscribers.current.size === 0;
			pagerSubscribers.current.add(appId);
			if (wasEmpty) send({ type: "subscribe", channel: "pager" });
		},
		[send],
	);

	const unsubscribePager = useCallback(
		(appId: string) => {
			pagerSubscribers.current.delete(appId);
			if (pagerSubscribers.current.size === 0) {
				send({ type: "unsubscribe", channel: "pager" });
				setPagerItems([]);
				pagerBuffer.current.clear();
			}
		},
		[send],
	);

	const subscribeMp3 = useCallback(
		(appId: string) => {
			const wasEmpty = mp3Subscribers.current.size === 0;
			mp3Subscribers.current.add(appId);
			if (wasEmpty) send({ type: "subscribe", channel: "mp3" });
		},
		[send],
	);

	const unsubscribeMp3 = useCallback(
		(appId: string) => {
			mp3Subscribers.current.delete(appId);
			if (mp3Subscribers.current.size === 0) {
				send({ type: "unsubscribe", channel: "mp3" });
				setMp3Items([]);
				mp3Buffer.current.clear();
			}
		},
		[send],
	);

	const subscribeNews = useCallback(
		(appId: string) => {
			const wasEmpty = newsSubscribers.current.size === 0;
			newsSubscribers.current.add(appId);
			if (wasEmpty) send({ type: "subscribe", channel: "news" });
		},
		[send],
	);

	const unsubscribeNews = useCallback(
		(appId: string) => {
			newsSubscribers.current.delete(appId);
			if (newsSubscribers.current.size === 0) {
				send({ type: "unsubscribe", channel: "news" });
				setNewsItems([]);
				newsBuffer.current.clear();
			}
		},
		[send],
	);

	// On every second tick: reveal buffered items the clock has now reached, then
	// prune expired ones. drainDue mutates the buffer (removing promoted entries);
	// the merged-then-filtered state both surfaces newly-due items and drops
	// expired ones in a single pass, keyed by the same `now`.
	useEffect(() => {
		const now = localDate.getTime();

		const dueMedia = drainDue(mediaBuffer.current, now);
		const dueMp3 = drainDue(mp3Buffer.current, now);
		const dueNews = drainDue(newsBuffer.current, now);
		const duePager = drainDue(pagerBuffer.current, now);

		setItems((prev) => mergeById(prev, dueMedia).filter((item) => keepMediaItem(item, now)));
		// mp3 items are durational audio — same retention rules as media items.
		setMp3Items((prev) => mergeById(prev, dueMp3).filter((item) => keepMediaItem(item, now)));
		// news items reuse the same retention rules (mostly instant headlines).
		setNewsItems((prev) => mergeById(prev, dueNews).filter((item) => keepMediaItem(item, now)));
		// Pager items are always instant — retain by start_date.
		setPagerItems((prev) => mergeById(prev, duePager).filter((p) => keepPagerItem(p, now)));
	}, [localDate]);

	// Detect manual time changes and send seek; ignore tick-driven minute boundaries
	useEffect(() => {
		const prevMs = new Date(prevDateTimeRef.current).getTime();
		const nowMs = new Date(dateTime).getTime();

		if (Math.abs(nowMs - prevMs) > SEEK_THRESHOLD_MS) {
			// The server sends a fresh window for the new instant; drop buffered
			// items from the old timeline so they never surface.
			mediaBuffer.current.clear();
			pagerBuffer.current.clear();
			mp3Buffer.current.clear();
			newsBuffer.current.clear();
			send({ type: "seek", time: new Date(dateTime).toISOString() });
		}

		prevDateTimeRef.current = dateTime;
	}, [dateTime, send]);

	// WebSocket lifecycle: connect once, heartbeat inside onopen
	useEffect(() => {
		let active = true;
		let heartbeatId: ReturnType<typeof setInterval>;
		const ws = new WebSocket(WS_URL);
		// Must be set synchronously at construction (not in onopen) so the first
		// binary frame arrives as an ArrayBuffer, not a Blob.
		ws.binaryType = "arraybuffer";
		wsRef.current = ws;

		ws.onopen = () => {
			// StrictMode cleanup may have run before the socket finished connecting.
			if (!active) {
				ws.close();
				return;
			}
			setConnected(true);
			ws.send(
				JSON.stringify({
					type: "init",
					time: localDateRef.current.toISOString(),
				}),
			);
			// Re-establish channel subscriptions after a reconnect — the server
			// does not remember subscriptions across connections.
			if (pagerSubscribers.current.size > 0) {
				ws.send(JSON.stringify({ type: "subscribe", channel: "pager" }));
			}
			if (mp3Subscribers.current.size > 0) {
				ws.send(JSON.stringify({ type: "subscribe", channel: "mp3" }));
			}
			if (newsSubscribers.current.size > 0) {
				ws.send(JSON.stringify({ type: "subscribe", channel: "news" }));
			}
			heartbeatId = setInterval(() => {
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(
						JSON.stringify({
							type: "heartbeat",
							time: localDateRef.current.toISOString(),
						}),
					);
				}
			}, HEARTBEAT_INTERVAL_MS);
		};

		ws.onmessage = (event: MessageEvent<ArrayBuffer>) => {
			if (!active) return;
			let msg: WsIncomingMessage;
			try {
				msg = decodeWireMessage<WsIncomingMessage>(event.data);
			} catch {
				return;
			}

			// Each frame is now a forward *window*: items already due surface
			// immediately; future items wait in the reveal buffer until the clock
			// reaches their start_date (preserving forward-only pacing). init_ack /
			// seek_ack snapshots are all active-now, so they land entirely in `due`.
			const now = localDateRef.current.getTime();

			// Time-independent source lists for filters — sent once at init. Replace
			// wholesale (the server always sends the complete set).
			if (msg.type === "sources") {
				const incoming = (msg as WsSourcesMessage).sources;
				if (incoming) {
					setSources({
						video: incoming.video ?? [],
						pager: incoming.pager ?? [],
					});
				}
				return;
			}

			if (msg.type === "pager") {
				const incomingPager = (msg as WsPagerMessage).pager;
				if (!incomingPager || incomingPager.length === 0) return;
				const { due, future } = partitionByDue(incomingPager, now);
				for (const p of future) pagerBuffer.current.set(p.id, p);
				const fresh = due.filter((p) => keepPagerItem(p, now));
				if (fresh.length > 0) setPagerItems((prev) => mergeById(prev, fresh));
				return;
			}

			if (msg.type === "mp3") {
				const incomingMp3 = (msg as WsMp3Message).items;
				if (!incomingMp3 || incomingMp3.length === 0) return;
				const { due, future } = partitionByDue(incomingMp3, now);
				for (const item of future) mp3Buffer.current.set(item.id, item);
				const fresh = due.filter((item) => keepMediaItem(item, now));
				if (fresh.length > 0) setMp3Items((prev) => mergeById(prev, fresh));
				return;
			}

			if (msg.type === "news") {
				const incomingNews = (msg as WsNewsMessage).items;
				if (!incomingNews || incomingNews.length === 0) return;
				const { due, future } = partitionByDue(incomingNews, now);
				for (const item of future) newsBuffer.current.set(item.id, item);
				const fresh = due.filter((item) => keepMediaItem(item, now));
				if (fresh.length > 0) setNewsItems((prev) => mergeById(prev, fresh));
				return;
			}

			if (msg.type !== "items" && msg.type !== "init_ack" && msg.type !== "seek_ack") return;

			const incoming = (msg as WsItemsMessage).items;
			if (incoming.length === 0) return;

			const { due, future } = partitionByDue(incoming, now);
			for (const item of future) mediaBuffer.current.set(item.id, item);
			const fresh = due.filter((item) => keepMediaItem(item, now));
			if (fresh.length > 0) setItems((prev) => mergeById(prev, fresh));
		};

		ws.onclose = () => {
			if (!active) return;
			setConnected(false);
			clearInterval(heartbeatId);
		};

		ws.onerror = () => {
			ws.close();
		};

		return () => {
			active = false;
			clearInterval(heartbeatId);
			ws.onclose = null;
			// Calling close() on a CONNECTING socket logs a browser error.
			// Defer to onopen so it can close cleanly once the handshake finishes.
			if (ws.readyState === WebSocket.CONNECTING) {
				ws.onopen = () => ws.close();
			} else {
				ws.close();
			}
			wsRef.current = null;
		};
		// Intentionally runs once on mount; localDateRef carries the live value
	}, []);

	return (
		<MediaStreamContext.Provider
			value={{
				items,
				pagerItems,
				mp3Items,
				newsItems,
				sources,
				connected,
				addItems,
				subscribeFormats,
				unsubscribeFormats,
				subscribePager,
				unsubscribePager,
				subscribeMp3,
				unsubscribeMp3,
				subscribeNews,
				unsubscribeNews,
			}}
		>
			{children}
		</MediaStreamContext.Provider>
	);
};
