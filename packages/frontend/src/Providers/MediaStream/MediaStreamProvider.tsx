import { useClassicyDateTime } from "classicy";
import {
	type FC,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { MediaStreamContext, type MediaItem } from "./MediaStreamContext";

// Instant items (start_date = end_date or calc_duration = 0) are kept for
// this many milliseconds after their start time before being pruned.
const INSTANT_RETENTION_MS = 10 * 60 * 1000; // 10 minutes

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

type WsIncomingMessage = WsItemsMessage | { type: string };

interface MediaStreamProviderProps {
	children: ReactNode;
}

export const MediaStreamProvider: FC<MediaStreamProviderProps> = ({
	children,
}) => {
	const { localDate, dateTime } = useClassicyDateTime({ tick: true });

	const [items, setItems] = useState<MediaItem[]>([]);
	const [connected, setConnected] = useState(false);

	// Per-app format subscriptions. null = wants all formats.
	const formatSubscriptions = useRef(new Map<string, string[] | null>());

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

	// Prune expired items on every second tick.
	// Instant items (start_date = end_date or calc_duration = 0) are kept for
	// INSTANT_RETENTION_MS after their start time instead of being pruned immediately.
	useEffect(() => {
		const now = localDate.getTime();
		setItems((prev) =>
			prev.filter((item) => {
				if (!item.end_date) return true;
				const endMs = new Date(item.end_date).getTime();
				if (item.start_date === item.end_date || (item.calc_duration ?? -1) === 0) {
					return now - endMs < INSTANT_RETENTION_MS;
				}
				return endMs > now;
			}),
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

		ws.onmessage = (event: MessageEvent<string>) => {
			if (!active) return;
			let msg: WsIncomingMessage;
			try {
				msg = JSON.parse(event.data) as WsIncomingMessage;
			} catch {
				return;
			}

			if (msg.type !== "items" && msg.type !== "init_ack" && msg.type !== "seek_ack") return;

			const incoming = (msg as WsItemsMessage).items;
			if (incoming.length === 0) return;

			const now = localDateRef.current.getTime();
			const fresh = incoming.filter((item) => {
				if (!item.end_date) return true;
				const endMs = new Date(item.end_date).getTime();
				if (item.start_date === item.end_date || (item.calc_duration ?? -1) === 0) {
					return now - endMs < INSTANT_RETENTION_MS;
				}
				return endMs > now;
			});

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
		<MediaStreamContext.Provider value={{ items, connected, addItems, subscribeFormats, unsubscribeFormats }}>
			{children}
		</MediaStreamContext.Provider>
	);
};
