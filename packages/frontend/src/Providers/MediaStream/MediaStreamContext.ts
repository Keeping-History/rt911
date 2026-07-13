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
	content?: string;
	sort?: number;
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
	/** Drop a flights-channel subscription. Unsubscribes server-side when the last app leaves. */
	unsubscribeFlights: (appId: string) => void;
	/** Accumulated flights_history chunks for the active loop-mode request. */
	flightsHistory: FlightPosition[];
	/** True once the active history request's done frame has arrived. */
	flightsHistoryDone: boolean;
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
}

export const MediaStreamContext = createContext<MediaStreamContextValue>({
	items: [],
	pagerItems: [],
	mp3Items: [],
	mp3History: [],
	newsItems: [],
	usenetItems: [],
	usenetBodies: {},
	usenetBodyErrors: {},
	requestUsenetBody: () => {},
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
	unsubscribeFlights: () => {},
	flightsHistory: [],
	flightsHistoryDone: false,
	requestFlightsHistory: () => {},
	clearFlightsHistory: () => {},
	weatherObservations: {},
	weatherForecastByZone: {},
	subscribeWeather: () => {},
	unsubscribeWeather: () => {},
	requestWeatherForecast: () => {},
});
