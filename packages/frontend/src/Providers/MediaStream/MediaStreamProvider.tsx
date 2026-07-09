import { useClassicyDateTime } from "classicy";
import {
	type FC,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	type AvailableSources,
	type FlightPosition,
	MediaStreamContext,
	type MediaItem,
	type PagerItem,
	type UsenetItem,
} from "./MediaStreamContext";
import { trackAck } from "./ackTracking";
import { decodeWireMessage } from "./wireCodec";
import { drainDue, partitionByDue } from "./revealBuffer";
import { keepInstantItem, keepMediaItem } from "./retention";
import { virtualUtcMs } from "./virtualClock";
import {
	applyUsenetBodyFrame,
	emptyUsenetBodyState,
	type UsenetBodyFrame,
} from "./usenetBodyCache";

// Merge incoming items into a prior list, de-duplicating by id (last write wins).
function mergeById<T extends { id: number }>(prev: T[], incoming: T[]): T[] {
	const byId = new Map(prev.map((i) => [i.id, i]));
	for (const item of incoming) byId.set(item.id, item);
	return Array.from(byId.values());
}

const WS_URL: string =
	(import.meta.env.VITE_MEDIA_STREAM_URL as string | undefined) ??
	"ws://localhost:8080/stream";

const HEARTBEAT_INTERVAL_MS = 30_000;

// Jumps larger than this are treated as manual seeks rather than clock ticks
const SEEK_THRESHOLD_MS = 90_000;

interface WsItemsMessage {
	type: "items" | "init_ack" | "seek_ack";
	time?: string;
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

// The complete mp3 back-catalogue up to the snapshot instant, sent with each mp3
// snapshot. Replaces client history state wholesale; may be empty (items omitted).
interface WsMp3HistoryMessage {
	type: "mp3_history";
	items?: MediaItem[];
}

interface WsNewsMessage {
	type: "news";
	items: MediaItem[];
}

// usenet messages ride their own field (not items) and carry per-message newsgroup.
interface WsUsenetMessage {
	type: "usenet";
	usenet: UsenetItem[];
}

interface WsUsenetBodyMessage {
	type: "usenet_body";
	id: number;
	body?: string;
	message?: string;
}

interface WsSourcesMessage {
	type: "sources";
	sources: AvailableSources;
}

// flight positions ride their own field (like usenet), not items.
interface WsFlightsMessage {
	type: "flights";
	flights: FlightPosition[];
}

// Chunked reply to a flights_history request. id echoes the request generation;
// the done frame (possibly empty) marks the window complete.
interface WsFlightsHistoryMessage {
	type: "flights_history";
	id?: number;
	flights?: FlightPosition[];
	done?: boolean;
}

type WsIncomingMessage =
	| WsItemsMessage
	| WsPagerMessage
	| WsMp3Message
	| WsMp3HistoryMessage
	| WsNewsMessage
	| WsUsenetMessage
	| WsUsenetBodyMessage
	| WsSourcesMessage
	| WsFlightsMessage
	| WsFlightsHistoryMessage
	| { type: string };

interface MediaStreamProviderProps {
	children: ReactNode;
}

export const MediaStreamProvider: FC<MediaStreamProviderProps> = ({
	children,
}) => {
	const { localDate, dateTime, tzOffset } = useClassicyDateTime({ tick: true });

	const [items, setItems] = useState<MediaItem[]>([]);
	const [pagerItems, setPagerItems] = useState<PagerItem[]>([]);
	const [mp3Items, setMp3Items] = useState<MediaItem[]>([]);
	const [mp3History, setMp3History] = useState<MediaItem[]>([]);
	const [newsItems, setNewsItems] = useState<MediaItem[]>([]);
	const [usenetItems, setUsenetItems] = useState<UsenetItem[]>([]);
	const [flightPositions, setFlightPositions] = useState<FlightPosition[]>([]);
	const [flightsHistory, setFlightsHistory] = useState<FlightPosition[]>([]);
	const [flightsHistoryDone, setFlightsHistoryDone] = useState(false);
	const [usenetBodyState, setUsenetBodyState] = useState(emptyUsenetBodyState);
	// Ids with a usenet_body request sent but not yet answered — prevents duplicate
	// fetches when a window re-renders before its body arrives.
	const usenetBodyInflight = useRef(new Set<number>());
	const [sources, setSources] = useState<AvailableSources>({ video: [], audio: [], pager: [], usenet: [] });
	const [connected, setConnected] = useState(false);

	// Per-app format subscriptions. null = wants all formats.
	const formatSubscriptions = useRef(new Map<string, string[] | null>());

	// Ref-counted channel subscribers. The server only delivers a channel's
	// items while at least one app is subscribed.
	const pagerSubscribers = useRef(new Set<string>());
	const mp3Subscribers = useRef(new Set<string>());
	const newsSubscribers = useRef(new Set<string>());
	const usenetSubscribers = useRef(new Set<string>());
	const flightsSubscribers = useRef(new Set<string>());
	// Active loop-history request: window wanted (null = loop off) and a
	// generation id echoed by the server so a superseded request's chunks are
	// discarded — frames from request N can still arrive after request N+1 goes out.
	const flightsHistoryMinutes = useRef<30 | 90 | null>(null);
	const flightsHistoryGen = useRef(0);
	// The newsgroup(s) the client is currently viewing — resent on reconnect.
	const usenetGroups = useRef<string[]>([]);

	// Reveal buffers: not-yet-due items from a windowed frame, keyed by id. The
	// per-second effect promotes each into live state when the virtual clock
	// reaches its start_date — this is what preserves forward-only pacing.
	const mediaBuffer = useRef(new Map<number, MediaItem>());
	const pagerBuffer = useRef(new Map<number, PagerItem>());
	const mp3Buffer = useRef(new Map<number, MediaItem>());
	const newsBuffer = useRef(new Map<number, MediaItem>());
	const usenetBuffer = useRef(new Map<number, UsenetItem>());
	const flightsBuffer = useRef(new Map<number, FlightPosition>());

	const addItems = useCallback((incoming: MediaItem[]) => {
		setItems((prev) => {
			const byId = new Map(prev.map((i) => [i.id, i]));
			for (const item of incoming) byId.set(item.id, item);
			return Array.from(byId.values());
		});
	}, []);

	const wsRef = useRef<WebSocket | null>(null);
	// Always-current virtual *UTC* instant (ms) for use inside WS callbacks and
	// intervals. localDate is the tz-shifted display clock; the stream lives in
	// UTC (item start_dates, the backend, seek, calcSeekSeconds), so we strip the
	// offset back off. Mismatching these is what kept short-lived radio/news items
	// trapped in the reveal buffer — see virtualClock.ts.
	const utcMsRef = useRef(virtualUtcMs(localDate, tzOffset));
	const prevDateTimeRef = useRef(dateTime);

	useEffect(() => {
		utcMsRef.current = virtualUtcMs(localDate, tzOffset);
	}, [localDate, tzOffset]);

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
				setMp3History([]);
				mp3Buffer.current.clear();
			}
		},
		[send],
	);

	const getUpcomingMp3Items = useCallback(
		(): MediaItem[] => Array.from(mp3Buffer.current.values()),
		[],
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

	const subscribeUsenet = useCallback(
		(appId: string) => {
			const wasEmpty = usenetSubscribers.current.size === 0;
			usenetSubscribers.current.add(appId);
			if (wasEmpty) send({ type: "subscribe", channel: "usenet" });
		},
		[send],
	);

	const unsubscribeUsenet = useCallback(
		(appId: string) => {
			usenetSubscribers.current.delete(appId);
			if (usenetSubscribers.current.size === 0) {
				send({ type: "unsubscribe", channel: "usenet" });
				usenetGroups.current = [];
				setUsenetItems([]);
				usenetBuffer.current.clear();
			}
		},
		[send],
	);

	const subscribeFlights = useCallback(
		(appId: string) => {
			const wasEmpty = flightsSubscribers.current.size === 0;
			flightsSubscribers.current.add(appId);
			if (wasEmpty) send({ type: "subscribe", channel: "flights" });
		},
		[send],
	);

	const unsubscribeFlights = useCallback(
		(appId: string) => {
			flightsSubscribers.current.delete(appId);
			if (flightsSubscribers.current.size === 0) {
				send({ type: "unsubscribe", channel: "flights" });
				setFlightPositions([]);
				flightsBuffer.current.clear();
				// Loop history is a flights-channel feature; drop it with the channel.
				flightsHistoryMinutes.current = null;
				flightsHistoryGen.current += 1;
				setFlightsHistory([]);
				setFlightsHistoryDone(false);
			}
		},
		[send],
	);

	// (Re-)issue the active history request: bump the generation, reset the
	// accumulated window, ask again. No-op while loop mode is off.
	const sendFlightsHistoryRequest = useCallback(() => {
		const minutes = flightsHistoryMinutes.current;
		if (minutes === null) return;
		flightsHistoryGen.current += 1;
		setFlightsHistory([]);
		setFlightsHistoryDone(false);
		send({ type: "flights_history", minutes, id: flightsHistoryGen.current });
	}, [send]);

	const requestFlightsHistory = useCallback(
		(minutes: 30 | 90) => {
			flightsHistoryMinutes.current = minutes;
			sendFlightsHistoryRequest();
		},
		[sendFlightsHistoryRequest],
	);

	const clearFlightsHistory = useCallback(() => {
		flightsHistoryMinutes.current = null;
		flightsHistoryGen.current += 1; // orphan any in-flight chunks
		setFlightsHistory([]);
		setFlightsHistoryDone(false);
	}, []);

	// Set the newsgroup(s) being viewed. The server resends a backlog for the new
	// group(s), so the current items + buffer are cleared to avoid mixing groups.
	const setUsenetGroups = useCallback(
		(groups: string[]) => {
			usenetGroups.current = groups;
			setUsenetItems([]);
			usenetBuffer.current.clear();
			send({ type: "usenet_filter", newsgroups: groups });
		},
		[send],
	);

	// Request the next page of older messages for a group; the server replies on the
	// usenet frame (all older items are ≤ clock, so they merge straight in).
	const requestUsenetOlder = useCallback(
		(newsgroup: string, before: string) => {
			send({ type: "usenet_more", newsgroups: [newsgroup], before });
		},
		[send],
	);

	// Fetch one message body on demand. Skips ids already cached, already errored,
	// or already in flight; bodies are immutable so a cached one is never refetched.
	const requestUsenetBody = useCallback(
		(id: number) => {
			if (
				id in usenetBodyState.bodies ||
				id in usenetBodyState.errors ||
				usenetBodyInflight.current.has(id)
			) {
				return;
			}
			usenetBodyInflight.current.add(id);
			send({ type: "usenet_body", id });
		},
		[send, usenetBodyState],
	);

	// On every second tick: reveal buffered items the clock has now reached, then
	// prune expired ones. drainDue mutates the buffer (removing promoted entries);
	// the merged-then-filtered state both surfaces newly-due items and drops
	// expired ones in a single pass, keyed by the same `now`.
	useEffect(() => {
		const now = virtualUtcMs(localDate, tzOffset);

		const dueMedia = drainDue(mediaBuffer.current, now);
		const dueMp3 = drainDue(mp3Buffer.current, now);
		const dueNews = drainDue(newsBuffer.current, now);
		const duePager = drainDue(pagerBuffer.current, now);
		const dueUsenet = drainDue(usenetBuffer.current, now);
		const dueFlights = drainDue(flightsBuffer.current, now);

		setItems((prev) => mergeById(prev, dueMedia).filter((item) => keepMediaItem(item, now)));
		// mp3 items are durational audio — same retention rules as media items.
		setMp3Items((prev) => mergeById(prev, dueMp3).filter((item) => keepMediaItem(item, now)));
		// news items reuse the same retention rules (mostly instant headlines).
		setNewsItems((prev) => mergeById(prev, dueNews).filter((item) => keepMediaItem(item, now)));
		// Pager items are always instant — retain by start_date.
		setPagerItems((prev) => mergeById(prev, duePager).filter((p) => keepInstantItem(p, now)));
		// Usenet messages are not time-pruned: a reader keeps browsing the group's
		// backlog. They are cleared only on group change, unsubscribe, or seek.
		if (dueUsenet.length > 0) setUsenetItems((prev) => mergeById(prev, dueUsenet));
		// Flight positions are instant per-minute samples — pager-style retention.
		setFlightPositions((prev) =>
			mergeById(prev, dueFlights).filter((p) => keepInstantItem(p, now)),
		);
	}, [localDate, tzOffset]);

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
			// The server resends a fresh usenet backlog for the active group(s) at the
			// new instant; drop the old-timeline messages so they don't linger.
			usenetBuffer.current.clear();
			setUsenetItems([]);
			flightsBuffer.current.clear();
			send({ type: "seek", time: new Date(dateTime).toISOString() });
			// The old timeline's loop history is meaningless at the new instant.
			sendFlightsHistoryRequest();
		}

		prevDateTimeRef.current = dateTime;
	}, [dateTime, send, sendFlightsHistoryRequest]);

	// Once the socket is OPEN, re-request the window for the current instant.
	// The active video channels are long-running stitched HLS streams (one row in
	// tv_channels per channel, started days ago) so they are delivered ONLY by the
	// init/seek snapshot — CurrentItems matches items overlapping the instant,
	// whereas the per-second refill is keyed by start_date over a forward window
	// and never re-sends an already-running channel. On the initial connect the
	// onopen `init` can run before the virtual clock has settled on its seeded
	// instant, and the clock-settle seek above is dropped while the socket is still
	// CONNECTING (send() no-ops unless OPEN) — leaving video empty with no recovery
	// until a manual date change. Issuing a seek for the freshest clock value once
	// connected guarantees the active channels arrive on every (re)connect.
	// biome-ignore lint/correctness/useExhaustiveDependencies: utcMsRef is a stable ref read for its latest value
	useEffect(() => {
		if (!connected) return;
		send({ type: "seek", time: new Date(utcMsRef.current).toISOString() });
	}, [connected, send]);

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
					time: new Date(utcMsRef.current).toISOString(),
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
			if (usenetSubscribers.current.size > 0) {
				ws.send(JSON.stringify({ type: "subscribe", channel: "usenet" }));
				// Restore the viewed-group filter so the backlog comes back after reconnect.
				if (usenetGroups.current.length > 0) {
					ws.send(JSON.stringify({ type: "usenet_filter", newsgroups: usenetGroups.current }));
				}
			}
			if (flightsSubscribers.current.size > 0) {
				ws.send(JSON.stringify({ type: "subscribe", channel: "flights" }));
				// Loop mode survives a reconnect: re-seed its window at the fresh clock.
				sendFlightsHistoryRequest();
			}
			// Body requests do not survive a reconnect; clear in-flight markers so
			// any open message window re-requests on its next render.
			usenetBodyInflight.current.clear();
			heartbeatId = setInterval(() => {
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(
						JSON.stringify({
							type: "heartbeat",
							time: new Date(utcMsRef.current).toISOString(),
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
			const now = utcMsRef.current;

			// Time-independent source lists for filters — sent once at init. Replace
			// wholesale (the server always sends the complete set).
			if (msg.type === "sources") {
				const incoming = (msg as WsSourcesMessage).sources;
				if (incoming) {
					setSources({
						video: incoming.video ?? [],
						audio: incoming.audio ?? [],
						pager: incoming.pager ?? [],
						usenet: incoming.usenet ?? [],
					});
				}
				return;
			}

			if (msg.type === "pager") {
				const incomingPager = (msg as WsPagerMessage).pager;
				if (!incomingPager || incomingPager.length === 0) return;
				const { due, future } = partitionByDue(incomingPager, now);
				for (const p of future) pagerBuffer.current.set(p.id, p);
				const fresh = due.filter((p) => keepInstantItem(p, now));
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

			if (msg.type === "mp3_history") {
				// The full back-catalogue up to the snapshot instant. Replace wholesale
				// (each frame is complete, and an empty one clears after a backward
				// seek); skip the reveal buffer and retention — history is already past.
				setMp3History((msg as WsMp3HistoryMessage).items ?? []);
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

			if (msg.type === "usenet") {
				const incomingUsenet = (msg as WsUsenetMessage).usenet;
				if (!incomingUsenet || incomingUsenet.length === 0) return;
				const { due, future } = partitionByDue(incomingUsenet, now);
				for (const item of future) usenetBuffer.current.set(item.id, item);
				// Backlog + due items surface immediately; no time-prune (see tick effect).
				if (due.length > 0) setUsenetItems((prev) => mergeById(prev, due));
				return;
			}

			if (msg.type === "usenet_body") {
				const frame = msg as WsUsenetBodyMessage;
				usenetBodyInflight.current.delete(frame.id);
				setUsenetBodyState((prev) =>
					applyUsenetBodyFrame(prev, frame as UsenetBodyFrame),
				);
				return;
			}

			if (msg.type === "flights_history") {
				const hist = msg as WsFlightsHistoryMessage;
				if (hist.id !== flightsHistoryGen.current) return; // superseded request
				const incoming = hist.flights ?? [];
				if (incoming.length > 0)
					setFlightsHistory((prev) => [...prev, ...incoming]);
				if (hist.done) setFlightsHistoryDone(true);
				return;
			}

			if (msg.type === "flights") {
				const incomingFlights = (msg as WsFlightsMessage).flights;
				if (!incomingFlights || incomingFlights.length === 0) return;
				const { due, future } = partitionByDue(incomingFlights, now);
				for (const p of future) flightsBuffer.current.set(p.id, p);
				const fresh = due.filter((p) => keepInstantItem(p, now));
				if (fresh.length > 0)
					setFlightPositions((prev) => mergeById(prev, fresh));
				return;
			}

			if (msg.type !== "items" && msg.type !== "init_ack" && msg.type !== "seek_ack") return;

			trackAck(msg.type, (msg as WsItemsMessage).time);

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
		// Intentionally runs once on mount; utcMsRef carries the live value.
		// sendFlightsHistoryRequest is stable (its only dep is the stable `send`),
		// so listing it satisfies the lint without re-running the effect.
	}, [sendFlightsHistoryRequest]);

	// Memoize the context value so consumers only re-render when specific data
	// changes — not on every provider render (which happens every clock tick and
	// on every classicy state update such as window-focus changes).
	const contextValue = useMemo(
		() => ({
			items,
			pagerItems,
			mp3Items,
			mp3History,
			newsItems,
			usenetItems,
			usenetBodies: usenetBodyState.bodies,
			usenetBodyErrors: usenetBodyState.errors,
			requestUsenetBody,
			sources,
			connected,
			addItems,
			subscribeFormats,
			unsubscribeFormats,
			subscribePager,
			unsubscribePager,
			subscribeMp3,
			unsubscribeMp3,
			getUpcomingMp3Items,
			subscribeNews,
			unsubscribeNews,
			subscribeUsenet,
			unsubscribeUsenet,
			setUsenetGroups,
			requestUsenetOlder,
			flightPositions,
			subscribeFlights,
			unsubscribeFlights,
			flightsHistory,
			flightsHistoryDone,
			requestFlightsHistory,
			clearFlightsHistory,
		}),
		[
			items,
			pagerItems,
			mp3Items,
			mp3History,
			newsItems,
			usenetItems,
			usenetBodyState,
			requestUsenetBody,
			sources,
			connected,
			addItems,
			subscribeFormats,
			unsubscribeFormats,
			subscribePager,
			unsubscribePager,
			subscribeMp3,
			unsubscribeMp3,
			getUpcomingMp3Items,
			subscribeNews,
			unsubscribeNews,
			subscribeUsenet,
			unsubscribeUsenet,
			setUsenetGroups,
			requestUsenetOlder,
			flightPositions,
			subscribeFlights,
			unsubscribeFlights,
			flightsHistory,
			flightsHistoryDone,
			requestFlightsHistory,
			clearFlightsHistory,
		],
	);

	return (
		<MediaStreamContext.Provider value={contextValue}>
			{children}
		</MediaStreamContext.Provider>
	);
};
