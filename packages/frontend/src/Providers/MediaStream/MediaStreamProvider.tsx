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
	MediaStreamContext,
	type MediaItem,
	type PagerItem,
} from "./MediaStreamContext";
import { decodeWireMessage } from "./wireCodec";

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

type WsIncomingMessage =
	| WsItemsMessage
	| WsPagerMessage
	| WsMp3Message
	| WsNewsMessage
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
	const [connected, setConnected] = useState(false);

	// Per-app format subscriptions. null = wants all formats.
	const formatSubscriptions = useRef(new Map<string, string[] | null>());

	// Ref-counted channel subscribers. The server only delivers a channel's
	// items while at least one app is subscribed.
	const pagerSubscribers = useRef(new Set<string>());
	const mp3Subscribers = useRef(new Set<string>());
	const newsSubscribers = useRef(new Set<string>());

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
			}
		},
		[send],
	);

	// Prune expired items on every second tick.
	useEffect(() => {
		const now = localDate.getTime();
		setItems((prev) => prev.filter((item) => keepMediaItem(item, now)));
		// mp3 items are durational audio — same retention rules as media items.
		setMp3Items((prev) => prev.filter((item) => keepMediaItem(item, now)));
		// news items reuse the same retention rules (mostly instant headlines).
		setNewsItems((prev) => prev.filter((item) => keepMediaItem(item, now)));
		// Pager items are always instant — retain by start_date.
		setPagerItems((prev) =>
			prev.filter((p) => now - new Date(p.start_date).getTime() < INSTANT_RETENTION_MS),
		);
	}, [localDate]);

	// Detect manual time changes and send seek; ignore tick-driven minute boundaries
	useEffect(() => {
		const prevMs = new Date(prevDateTimeRef.current).getTime();
		const nowMs = new Date(dateTime).getTime();

		if (Math.abs(nowMs - prevMs) > SEEK_THRESHOLD_MS) {
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

			if (msg.type === "pager") {
				const incomingPager = (msg as WsPagerMessage).pager;
				if (!incomingPager || incomingPager.length === 0) return;
				const nowPager = localDateRef.current.getTime();
				const freshPager = incomingPager.filter(
					(p) => nowPager - new Date(p.start_date).getTime() < INSTANT_RETENTION_MS,
				);
				if (freshPager.length === 0) return;
				setPagerItems((prev) => {
					const byId = new Map(prev.map((p) => [p.id, p]));
					for (const p of freshPager) byId.set(p.id, p);
					return Array.from(byId.values());
				});
				return;
			}

			if (msg.type === "mp3") {
				const incomingMp3 = (msg as WsMp3Message).items;
				if (!incomingMp3 || incomingMp3.length === 0) return;
				const nowMp3 = localDateRef.current.getTime();
				const freshMp3 = incomingMp3.filter((item) => keepMediaItem(item, nowMp3));
				if (freshMp3.length === 0) return;
				setMp3Items((prev) => {
					const byId = new Map(prev.map((i) => [i.id, i]));
					for (const item of freshMp3) byId.set(item.id, item);
					return Array.from(byId.values());
				});
				return;
			}

			if (msg.type === "news") {
				const incomingNews = (msg as WsNewsMessage).items;
				if (!incomingNews || incomingNews.length === 0) return;
				const nowNews = localDateRef.current.getTime();
				const freshNews = incomingNews.filter((item) => keepMediaItem(item, nowNews));
				if (freshNews.length === 0) return;
				setNewsItems((prev) => {
					const byId = new Map(prev.map((i) => [i.id, i]));
					for (const item of freshNews) byId.set(item.id, item);
					return Array.from(byId.values());
				});
				return;
			}

			if (msg.type !== "items" && msg.type !== "init_ack" && msg.type !== "seek_ack") return;

			const incoming = (msg as WsItemsMessage).items;
			if (incoming.length === 0) return;

			const now = localDateRef.current.getTime();
			const fresh = incoming.filter((item) => keepMediaItem(item, now));

			setItems((prev) => {
				const byId = new Map(prev.map((i) => [i.id, i]));
				for (const item of fresh) {
					byId.set(item.id, item);
				}
				return Array.from(byId.values());
			});
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
