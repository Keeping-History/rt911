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

export interface MediaStreamContextValue {
	items: MediaItem[];
	/** Pager items received while subscribed to the pager channel. */
	pagerItems: PagerItem[];
	/** mp3 (Radio) items received while subscribed to the mp3 channel. Same shape as items. */
	mp3Items: MediaItem[];
	/** news items received while subscribed to the news channel. Same shape as items. */
	newsItems: MediaItem[];
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
}

export const MediaStreamContext = createContext<MediaStreamContextValue>({
	items: [],
	pagerItems: [],
	mp3Items: [],
	newsItems: [],
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
});
