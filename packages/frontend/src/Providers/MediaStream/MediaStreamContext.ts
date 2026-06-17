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
	content?: string;
	sort?: number;
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
	body?: string;
	date_source?: string;
	approved?: number;
}

/**
 * Time-independent sets of selectable sources for each filter, delivered once by
 * the server on the `sources` frame (see the streamer's websocket-protocol.md).
 * Unlike the source values derived from streamed items, these list every option
 * across all history — so filter UIs are complete regardless of the virtual clock.
 */
export interface AvailableSources {
	/** Source slugs with approved video (m3u8) media — the TV channel filter. */
	video: string[];
	/** Providers across approved pager items — the Pager provider filter. */
	pager: string[];
	/** Newsgroup names (sources of type "usenet") — the Newsgroups browse list. */
	usenet: string[];
}

export interface MediaStreamContextValue {
	items: MediaItem[];
	/** Pager items received while subscribed to the pager channel. */
	pagerItems: PagerItem[];
	/** mp3 (Radio) items received while subscribed to the mp3 channel. Same shape as items. */
	mp3Items: MediaItem[];
	/** news items received while subscribed to the news channel. Same shape as items. */
	newsItems: MediaItem[];
	/** usenet messages received for the currently-viewed newsgroup(s). */
	usenetItems: UsenetItem[];
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
}

export const MediaStreamContext = createContext<MediaStreamContextValue>({
	items: [],
	pagerItems: [],
	mp3Items: [],
	newsItems: [],
	usenetItems: [],
	sources: { video: [], pager: [], usenet: [] },
	connected: false,
	addItems: () => {},
	subscribeFormats: () => {},
	unsubscribeFormats: () => {},
	subscribePager: () => {},
	unsubscribePager: () => {},
	subscribeMp3: () => {},
	unsubscribeMp3: () => {},
	subscribeNews: () => {},
	unsubscribeNews: () => {},
	subscribeUsenet: () => {},
	unsubscribeUsenet: () => {},
	setUsenetGroups: () => {},
});
