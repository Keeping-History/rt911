// Shared option shape for the video embeds. Kept in its own module (no React
// component exports) so both DirectusVideoPart and DirectusMultiviewPart can
// import it without tripping react-refresh's component-only rule.

export interface DirectusVideoOptions {
	channelId?: string | number;
	/** Direct HLS URL; skips the Directus fetch. */
	url?: string;
	/** Title override (else the channel's title). */
	title?: string;
	/** Segment bounds — stream offset (number/"M:SS") or wall-clock datetime. */
	start?: string | number;
	end?: string | number;
	/** Show the native transport (default true). */
	controls?: boolean;
	autoPlay?: boolean;
	/** Loop the [start, end] segment. */
	loop?: boolean;
	/** Mute audio (defaults to true when autoPlay is set, so autoplay is allowed). */
	muted?: boolean;
	/** Initial volume, 0–1. */
	volume?: number;
	/** Captions shown by default; the CC control still toggles them at runtime. */
	captions?: boolean;
	/** Placeholder image shown before playback / while the stream buffers. */
	poster?: string;
	/** Draw a channel-name + running-time bug over the video. */
	overlay?: boolean;
}

/** Coerce an untyped stack `options` object into {@link DirectusVideoOptions}. */
export function readVideoOptions(options: Record<string, unknown>): DirectusVideoOptions {
	const o = options;
	const str = (v: unknown) => (typeof v === "string" ? v : undefined);
	const numOrStr = (v: unknown) =>
		typeof v === "number" || typeof v === "string" ? (v as string | number) : undefined;
	return {
		channelId: numOrStr(o.channelId ?? o.itemId),
		url: str(o.url),
		title: str(o.title),
		start: numOrStr(o.start),
		end: numOrStr(o.end),
		controls: o.controls === undefined ? true : o.controls === true,
		autoPlay: o.autoPlay === true,
		loop: o.loop === true,
		muted: typeof o.muted === "boolean" ? o.muted : undefined,
		volume: typeof o.volume === "number" ? o.volume : undefined,
		captions: o.captions === true,
		poster: str(o.poster),
		overlay: o.overlay === true,
	};
}
