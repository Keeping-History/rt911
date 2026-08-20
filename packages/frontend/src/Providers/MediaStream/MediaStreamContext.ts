import { createContext } from "react";

export interface CalcDurationFilter {
	gt?: number;
	gte?: number;
	lt?: number;
	lte?: number;
}

export interface MediaStreamFilter {
	/** Keep items whose calc_duration satisfies the given comparisons. */
	calcDuration?: CalcDurationFilter;
	/** Keep only approved (true) or unapproved (false) items. */
	approved?: boolean;
	/** Keep items whose timezone equals the value or is in the list. */
	timezone?: string | string[];
	/** Keep items whose format equals the value or is in the list. */
	format?: string | string[];
	/** true = must have an image; false = must have no image. */
	image?: boolean;
	/** Keep items whose source slug equals the value or is in the list. */
	source?: string | string[];
	/** Keep only muted (true) or audible (false) items. */
	mute?: boolean;
}

export interface MediaItem {
	id: number;
	title: string;
	full_title: string;
	source?: string;
	start_date: string;
	end_date?: string;
	calc_duration?: number;
	timezone?: string;
	url: string;
	format: string;
	approved: number;
	mute: number;
	volume: number;
	jump: number;
	trim: number;
	image?: string;
	image_caption?: string;
	/** Public URL to the .srt subtitle file; the .vtt sibling is derived for <track>. */
	subtitles?: string;
	/**
	 * Public URL to the noise-reduced render, when one exists.
	 *
	 * `url` stays canonical and always points at the source recording — it is the
	 * join key for the whole audio pipeline. This is the listening copy, and it is
	 * null until the enhancement pass has processed that file.
	 */
	enhanced_url?: string | null;
	content?: string;
	sort?: number;
}

/**
 * One tag in the mp3 corpus' controlled vocabulary — `facility:zbw` and the
 * pieces the sidebar renders it from. The same shape appears twice: on an
 * item's own `tags` (from the mp3_meta frame) and in the vocabulary served by
 * `GET /mp3/tags`, which is what makes the two comparable at all.
 */
export interface TagDef {
	tag: string;
	namespace?: string;
	value?: string;
	color?: string;
}

/** One party to a recorded conversation. */
export interface Participant {
	person?: string;
	facility?: string;
	position?: string;
	role?: string;
	confidence?: string;
}

/**
 * Entities a recording names without being party to. All three lists are always
 * present (possibly empty) because the derivation always writes all three — a
 * card has to be able to say "nobody else was named" definitely.
 */
export interface Mentions {
	facilities: string[];
	aircraft: string[];
	people: string[];
}

/**
 * The Radio Traffic card's view of one mp3 item: who the traffic is between,
 * what it is about, how far to trust that, and the waveform envelope.
 *
 * Deliberately NOT part of MediaItem. `mp3_history` carries the whole ~755-item
 * back catalogue and is re-sent in full on every seek, so a field here folded
 * into MediaItem would cost roughly 1.5 MB of msgpack on every Time Machine
 * scrub. It arrives once instead, on the one-shot `mp3_meta` frame.
 *
 * Every field is optional but `tags`, which the server always sends (empty when
 * nothing is tagged) so "this item has no tags" is distinguishable from "this
 * item has no metadata at all" — the latter being an id absent from mp3Meta.
 */
export interface ItemMeta {
	subject?: string;
	link?: string;
	tier?: string;
	confidence?: string;
	evidence?: string;
	participants?: Participant[];
	mentions?: Mentions;
	/**
	 * Where the published values came from, path by path. Left opaque: nothing
	 * renders it yet, and typing a shape no consumer reads would be a guess
	 * about a display that hasn't been designed.
	 */
	provenance?: unknown;
	tags?: TagDef[];
	/** 480 [min, max] amplitude buckets scaled to -128..127. */
	peaks?: [number, number][];
}

/**
 * A background alert, delivered on the opt-in "alerts" channel. Reuses the MediaItem
 * shape (headline in title, HTML body in content, plus image/image_caption/start_date)
 * and adds severity, which selects the ClassicyAlert icon.
 */
export interface AlertItem extends MediaItem {
	severity?: "note" | "caution" | "stop";
}

/** HTML5 <track> needs WebVTT; the producer writes a .vtt next to every .srt. */
export function vttUrl(srtUrl?: string): string | undefined {
	if (!srtUrl) return undefined;
	return srtUrl.replace(/\.srt$/i, ".vtt");
}

/**
 * A single historical pager message, delivered on the opt-in "pager" channel.
 * Unlike MediaItem, pager items are instant (a start_date with no duration) and
 * carry pager-specific metadata as first-class fields — no content JSON to parse.
 */
export interface PagerItem {
	id: number;
	start_date: string;
	provider?: string;
	recipient_id?: string;
	id_type?: string;
	channel?: string;
	mode?: string;
	message: string;
	approved?: number;
}

/**
 * A single archived Usenet message, delivered on the opt-in "usenet" channel.
 * Like pager items they are instant (a start_date with no duration). Unlike the
 * other channels, delivery is filtered server-side by newsgroup — the client
 * declares which group(s) it is viewing via setUsenetGroups, and only those are
 * streamed (a group can hold millions of messages). thread_id/parent_id carry the
 * restored thread structure for building the conversation tree.
 */
export interface UsenetItem {
	id: number;
	start_date: string;
	newsgroup?: string;
	subject?: string;
	author?: string;
	message_id?: string;
	references?: string;
	in_reply_to?: string;
	thread_id?: string;
	parent_id?: string;
	date_source?: string;
	approved?: number;
}

/**
 * One per-minute reconstructed aircraft position sample, delivered on the
 * opt-in "flights" channel. Instant items like pager (a start_date, no
 * duration); a map consumer keeps the latest sample per `flight`. Full track
 * geometry (flight_tracks) is NOT streamed — apps fetch it from Directus on
 * demand.
 */
export interface FlightPosition {
	id: number;
	flight: string;
	carrier?: string;
	start_date: string;
	lat: number;
	lon: number;
	alt_ft: number;
	phase?: string;
	diverted?: boolean;
}

/**
 * A single station observation (METAR), delivered on the opt-in "weather"
 * channel. Unlike pager/flights, the channel exposes only the latest reading
 * per station (weatherObservations keyed by station_id) rather than a list —
 * observations are sparse (about one per station per hour) and a station that
 * has gone quiet still shows its last reading. Nullable numeric fields are
 * absent (not zero) when the station didn't report them.
 */
export interface WeatherObservation {
	id: number;
	station_id: string;
	start_date: string;
	temp_c?: number;
	dewpoint_c?: number;
	wind_dir_deg?: number;
	wind_speed_kt?: number;
	gust_kt?: number;
	pressure_hpa?: number;
	sky_condition?: string;
	present_weather?: string;
	visibility_km?: number;
	raw_metar?: string;
}

/**
 * An archived NWS forecast product (zone forecast, area forecast discussion,
 * etc.), fetched on demand via requestWeatherForecast rather than streamed —
 * the weather channel's snapshot/window frames never include these directly
 * in weatherForecastByZone; only an explicit request/reply round-trip does.
 */
export interface WeatherForecast {
	id: number;
	wfo: string;
	zone: string;
	product_type: string;
	start_date: string;
	raw_text: string;
}

/**
 * Time-independent sets of selectable sources for each filter, delivered once by
 * the server on the `sources` frame (see the streamer's websocket-protocol.md).
 * Unlike the source values derived from streamed items, these list every option
 * across all history — so filter UIs are complete regardless of the virtual clock.
 */
/** A browseable newsgroup: name + precomputed message count. */
export interface NewsgroupSource {
	name: string;
	count: number;
}

export interface AvailableSources {
	/** Source slugs with approved video (m3u8) media — the TV channel filter. */
	video: string[];
	/** Source slugs with approved audio (MP3) media — the RadioScanner offline stations filter. */
	audio: string[];
	/** Providers across approved pager items — the Pager provider filter. */
	pager: string[];
	/** Newsgroups (sources of type "usenet") with message counts — the browse list. */
	usenet: NewsgroupSource[];
}

/**
 * Reason the chat channel is (or isn't) usable right now, mirrored from the
 * server's chat_state frame. Starts (in the default context) at
 * "not_signed_in" — see chatReason on MediaStreamContextValue.
 */
export type ChatStateReason = "ok" | "paused" | "outside_window" | "blocked" | "not_signed_in";

/**
 * One AIM-style buddy on the roster, delivered on the opt-in "chat" channel
 * via chat_roster (full replace) and chat_presence (online flips).
 */
export interface ChatBuddy {
	profile: number;
	screen_name: string;
	display_name: string;
	avatar: string;
	online: boolean;
	profile_text?: string;
}

/**
 * A single chat line, in or out, delivered on the "chat" channel via
 * chat_message. Append-only client-side; the chat app splits the list by
 * profile per conversation.
 */
export interface ChatMessage {
	message_id: number;
	profile: number;
	direction: "in" | "out";
	body: string;
	/** RFC3339 virtual time. */
	time: string;
	/** typed | generated | scheduled | static | stall | refused | truncated */
	kind: string;
}

/** Forced clock mode: the server owns the clock while active. */
export interface WsClockMessage {
	type: "clock";
	active: boolean;
	time?: string;
}

export interface WsHeartbeatAckMessage {
	type: "heartbeat_ack";
	time: string;
	/** Present only while forced mode is active. */
	master_time?: string;
}

/**
 * A live teacher action pushed to every student in a room. Rooms are playlist
 * ids: the streamer relays these across pods (see internal/fanout) so a class
 * split over several replicas stays in step.
 */
export interface RoomCommand {
	action: "jump" | "focus" | "message" | "lock" | "reload";
	/** Virtual-clock target for "jump", as a UTC string. */
	time?: string;
	/** Classicy app id for "focus", e.g. "TV.app". */
	app?: string;
	/** Note body for "message". */
	message?: string;
	/** Lock surface for "lock". Only the clock is implemented today. */
	target?: "clock";
	/**
	 * Lock state for "lock". Optional-but-meaningful: the server sends it as a
	 * pointer precisely so an unlock (`false`) survives the wire, so treat a
	 * missing value as "no instruction" rather than as `false`.
	 */
	on?: boolean;
	/** Monotonic per-client counter; see roomCommand above. */
	seq: number;
}

export interface MediaStreamContextValue {
	items: MediaItem[];
	/** Pager items received while subscribed to the pager channel. */
	pagerItems: PagerItem[];
	/** mp3 (Radio) items received while subscribed to the mp3 channel. Same shape as items. */
	mp3Items: MediaItem[];
	/**
	 * The complete mp3 back-catalogue up to the virtual clock (every item with
	 * start_date ≤ t), replaced wholesale on each mp3_history frame (subscribe/
	 * init/seek). Unlike mp3Items it is never reveal-gated or retention-pruned —
	 * it backs the Radio app's full "Previous" schedule.
	 */
	mp3History: MediaItem[];
	/**
	 * Radio Traffic metadata for the whole mp3 corpus, keyed by item id, from
	 * the one-shot `mp3_meta` frame.
	 *
	 * Alone among this provider's channels it is NOT time-scoped, so it is
	 * exempt from both the reveal gate and retention pruning, and a seek leaves
	 * it untouched: the server sends the frame once per session and never
	 * resends it, so anything that dropped it would leave the cards bare for the
	 * rest of the session with nothing left to restore them.
	 *
	 * An id with no entry has no derived metadata (59 of 814 recordings have no
	 * `parties` blob) — reading one yields undefined, and the card falls back to
	 * its title and transcript.
	 */
	mp3Meta: Record<number, ItemMeta>;
	/**
	 * The cache build `mp3Meta` came from, or null before the frame arrives.
	 * `GET /mp3/tags` stamps the same value, so a client holding a vocabulary
	 * from build N and item tags from N+1 can see the mismatch and refetch
	 * rather than render a tag chip its own filter tree has no checkbox for.
	 */
	mp3MetaGeneration: string | null;
	/** news items received while subscribed to the news channel. Same shape as items. */
	newsItems: MediaItem[];
	/** usenet messages received for the currently-viewed newsgroup(s). */
	usenetItems: UsenetItem[];
	/** Fetched Usenet article bodies, keyed by message id (on-demand). */
	usenetBodies: Record<number, string>;
	/** Failure messages for body fetches that could not be served, keyed by id. */
	usenetBodyErrors: Record<number, string>;
	/** Request one message's body by id; no-ops if already fetched or in flight. */
	requestUsenetBody: (id: number) => void;
	/** On-demand news article bodies, keyed by item id (snapshot rows omit content). */
	newsBodies: Record<number, string>;
	/** Failure messages for news bodies that could not be fetched, keyed by item id. */
	newsBodyErrors: Record<number, string>;
	/** Request one news article's body; de-dupes against cached and in-flight ids. */
	requestNewsBody: (id: number) => void;
	/** All selectable sources per filter, sent once by the server at init. */
	sources: AvailableSources;
	connected: boolean;
	addItems: (items: MediaItem[]) => void;
	/** Register a set of desired formats for an app. null = want all formats. */
	subscribeFormats: (appId: string, formats: string[] | null) => void;
	/** Remove a previously registered format subscription. */
	unsubscribeFormats: (appId: string) => void;
	/** Opt into pager-channel delivery. Ref-counted by appId. */
	subscribePager: (appId: string) => void;
	/** Drop a pager-channel subscription. Unsubscribes server-side when the last app leaves. */
	unsubscribePager: (appId: string) => void;
	/** Opt into mp3-channel delivery. Ref-counted by appId. */
	subscribeMp3: (appId: string) => void;
	/** Drop an mp3-channel subscription. Unsubscribes server-side when the last app leaves. */
	unsubscribeMp3: (appId: string) => void;
	/** Snapshot of mp3 items waiting in the reveal buffer (start_date still in the future). */
	getUpcomingMp3Items: () => MediaItem[];
	/** Opt into news-channel delivery. Ref-counted by appId. */
	subscribeNews: (appId: string) => void;
	/** Drop a news-channel subscription. Unsubscribes server-side when the last app leaves. */
	unsubscribeNews: (appId: string) => void;
	/** Opt into usenet-channel delivery. Ref-counted by appId. */
	subscribeUsenet: (appId: string) => void;
	/** Drop a usenet-channel subscription. Unsubscribes server-side when the last app leaves. */
	unsubscribeUsenet: (appId: string) => void;
	/** Set the newsgroup(s) the client is viewing; only these are streamed. Empty = none. */
	setUsenetGroups: (groups: string[]) => void;
	/** Request the page of messages older than `before` for a group (backlog pagination). */
	requestUsenetOlder: (newsgroup: string, before: string) => void;
	/** Flight positions received while subscribed to the flights channel. */
	flightPositions: FlightPosition[];
	/** Opt into flights-channel delivery. Ref-counted by appId. */
	subscribeFlights: (appId: string) => void;
	/** Opt into the anonymous radar-traffic corpus (RDR-… ids, #263). */
	subscribeFlightsAnon: (appId: string) => void;
	/** Drop a flights-channel subscription. Unsubscribes server-side when the last app leaves. */
	unsubscribeFlights: (appId: string) => void;
	unsubscribeFlightsAnon: (appId: string) => void;
	/** Accumulated flights_history chunks for the active loop-mode request. */
	flightsHistory: FlightPosition[];
	/** True once the active history request's done frame has arrived. */
	flightsHistoryDone: boolean;
	/**
	 * Short history lookback around the current instant, auto-fetched whenever
	 * the flights channel (re)starts — subscribe, seek, reconnect. Gives the
	 * Flight Tracker a previous sample per airborne flight so headings render
	 * immediately (a fresh snapshot alone has one sample per flight, which
	 * would leave every plane pointing north for its first minute).
	 */
	flightsSeed: FlightPosition[];
	/**
	 * Request the trailing `minutes` of flight positions for loop playback.
	 * Replaces any prior request; the provider re-issues it on seek/reconnect.
	 */
	requestFlightsHistory: (minutes: 30 | 90) => void;
	/** Drop history state and stop re-issuing on seek/reconnect (loop mode off). */
	clearFlightsHistory: () => void;
	/** Latest observation per station, keyed by station_id, from the weather channel. */
	weatherObservations: Record<string, WeatherObservation>;
	/**
	 * Forecast products fetched via requestWeatherForecast, keyed by zone.
	 * `null` is an explicit, confirmed "no product covers this zone yet" answer
	 * from the server — distinct from a key simply being absent (never requested
	 * / still awaiting reply).
	 */
	weatherForecastByZone: Record<string, WeatherForecast | null>;
	/** Opt into weather-channel delivery. Ref-counted by appId. */
	subscribeWeather: (appId: string) => void;
	/** Drop a weather-channel subscription. Unsubscribes server-side when the last app leaves. */
	unsubscribeWeather: (appId: string) => void;
	/**
	 * Request the forecast product covering `zone` at the client's virtual
	 * time. Replaces any prior pending request; stale replies (superseded by a
	 * newer request) are dropped via an internally-managed id echo.
	 */
	requestWeatherForecast: (zone: string) => void;
	/** True while the server is forcing the clock (Time Machine locked). */
	clockForced: boolean;
	/**
	 * True between dispatching a `{type:"seek"}` and the first mp3 frame that
	 * answers it. One connection-level flag, not one per item: a seek drops
	 * every buffer at once, so nothing that follows the virtual clock has valid
	 * data until the fresh window lands. The Radio Traffic card reads it for its
	 * SEEKING badge, which appears on one card at a time only because one card
	 * is following the clock.
	 *
	 * Cleared by `mp3` OR `mp3_history` — whichever arrives first. `mp3_history`
	 * is the load-bearing one: it is sent on every seek even when empty, whereas
	 * seeking into a stretch with no audio produces no `mp3` frame at all, which
	 * would strand the flag raised.
	 */
	seekInFlight: boolean;

	/**
	 * The most recent live teacher command for the room this client joined
	 * (its `?playlist=` id), or null if none has arrived. `seq` increments on
	 * every command so an identical repeat — a teacher pressing "focus TV"
	 * twice — is still observable as a new event by effects keyed on it.
	 */
	roomCommand: RoomCommand | null;
	/** alerts received while subscribed to the alerts channel. */
	alertItems: AlertItem[];
	/** Opt into alerts-channel delivery. Ref-counted by appId. */
	subscribeAlerts: (appId: string) => void;
	/** Drop an alerts-channel subscription. Unsubscribes server-side when the last app leaves. */
	unsubscribeAlerts: (appId: string) => void;
	/** The buddy roster, replaced wholesale on each chat_roster frame. */
	chatBuddies: ChatBuddy[];
	/** Whether the chat channel is currently usable, from the last chat_state frame. */
	chatEnabled: boolean;
	/**
	 * Why chat is (or isn't) usable. Starts at "not_signed_in" rather than
	 * "ok" — assuming a working chat before the first chat_state frame would
	 * flash an enabled UI at someone who cannot use it.
	 */
	chatReason: ChatStateReason;
	/** Chat lines received while subscribed to the chat channel. Append-only; the app splits by profile. */
	chatMessages: ChatMessage[];
	/**
	 * The buddy currently generating a reply, or null. Set by chat_typing and
	 * cleared by the next chat_message — the reply is what ends the
	 * indicator, not a timer.
	 */
	chatTypingProfile: number | null;
	/** Opt into chat-channel delivery. Ref-counted by appId. */
	subscribeChat: (appId: string) => void;
	/** Drop a chat-channel subscription. Unsubscribes server-side when the last app leaves. */
	unsubscribeChat: (appId: string) => void;
	/** Send a chat message to a buddy. */
	sendChat: (profile: number, body: string) => void;
	/** Request the page of chat history older than `before` for a buddy (backlog pagination). */
	requestChatHistory: (profile: number, before: string, limit: number) => void;
	/**
	 * Append the student's own just-sent line to `chatMessages`. The server
	 * never echoes an inbound turn (it persists it; live chat_message frames
	 * are all direction "out"), so without this the student's words never
	 * appear. Same array as the server frames — insertion order is the whole
	 * ordering rule.
	 */
	appendLocalChatMessage: (message: ChatMessage) => void;
	/**
	 * Soft-delete this user's entire chat history, every buddy at once. The
	 * server marks the rows old rather than deleting them and replies
	 * `chat_cleared`; `chatMessages` empties on THAT frame, not on this call, so
	 * a rejected or failed clear leaves the transcript on screen untouched.
	 */
	clearChatData: () => void;
}

export const MediaStreamContext = createContext<MediaStreamContextValue>({
	items: [],
	pagerItems: [],
	mp3Items: [],
	mp3History: [],
	mp3Meta: {},
	mp3MetaGeneration: null,
	newsItems: [],
	usenetItems: [],
	usenetBodies: {},
	usenetBodyErrors: {},
	requestUsenetBody: () => {},
	newsBodies: {},
	newsBodyErrors: {},
	requestNewsBody: () => {},
	sources: { video: [], audio: [], pager: [], usenet: [] },
	connected: false,
	addItems: () => {},
	subscribeFormats: () => {},
	unsubscribeFormats: () => {},
	subscribePager: () => {},
	unsubscribePager: () => {},
	subscribeMp3: () => {},
	unsubscribeMp3: () => {},
	getUpcomingMp3Items: () => [],
	subscribeNews: () => {},
	unsubscribeNews: () => {},
	subscribeUsenet: () => {},
	unsubscribeUsenet: () => {},
	setUsenetGroups: () => {},
	requestUsenetOlder: () => {},
	flightPositions: [],
	subscribeFlights: () => {},
	subscribeFlightsAnon: () => {},
	unsubscribeFlights: () => {},
	unsubscribeFlightsAnon: () => {},
	flightsHistory: [],
	flightsHistoryDone: false,
	flightsSeed: [],
	requestFlightsHistory: () => {},
	clearFlightsHistory: () => {},
	weatherObservations: {},
	weatherForecastByZone: {},
	subscribeWeather: () => {},
	unsubscribeWeather: () => {},
	requestWeatherForecast: () => {},
	clockForced: false,
	seekInFlight: false,
	roomCommand: null,
	alertItems: [],
	subscribeAlerts: () => {},
	unsubscribeAlerts: () => {},
	chatBuddies: [],
	chatEnabled: false,
	chatReason: "not_signed_in",
	chatMessages: [],
	chatTypingProfile: null,
	subscribeChat: () => {},
	unsubscribeChat: () => {},
	sendChat: () => {},
	requestChatHistory: () => {},
	appendLocalChatMessage: () => {},
	clearChatData: () => {},
});
