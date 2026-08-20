import type { HyperCardPartProps } from "classicy";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	type DirectusAudioItem,
	fetchDirectusAudioItem,
} from "./directusCollections";
import "./DirectusAudioPart.css";

/**
 * `directusAudio` HyperCard part — embeds one audio file from the `mp3_items`
 * Directus collection into a card.
 *
 * Authored in a stack's JSON as a part whose `options` name the clip:
 *
 *   { "id": "clip", "type": "directusAudio", "rect": [16, 60, 388, 96],
 *     "options": { "itemId": 42 } }
 *
 * Resolution order for the source:
 *   1. `options.url`   — a direct audio URL (no fetch; also sets `title`).
 *   2. `options.itemId` (or, when absent, the part's own field value) — fetched
 *      from `mp3_items` and rendered from the row's `url`/`title`.
 *
 * `itemId` is passed through the stack's expression evaluator (`resolve`), so an
 * author can bind it to a variable/field (e.g. `options.itemId: "currentClip"`)
 * and drive playback from a script; a bare number or id resolves to itself.
 */

interface DirectusAudioOptions {
	itemId?: string | number;
	url?: string;
	title?: string;
	autoPlay?: boolean;
	loop?: boolean;
	preload?: "none" | "metadata" | "auto";
}

type LoadState =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "ready"; item: DirectusAudioItem }
	| { status: "error"; message: string };

function readOptions(options: Record<string, unknown>): DirectusAudioOptions {
	const o = options as DirectusAudioOptions;
	return {
		itemId: typeof o.itemId === "string" || typeof o.itemId === "number" ? o.itemId : undefined,
		url: typeof o.url === "string" ? o.url : undefined,
		title: typeof o.title === "string" ? o.title : undefined,
		autoPlay: o.autoPlay === true,
		loop: o.loop === true,
		preload: o.preload === "none" || o.preload === "auto" ? o.preload : "metadata",
	};
}

export const DirectusAudioPart = ({
	options,
	value,
	locked,
	resolve,
}: HyperCardPartProps) => {
	const opts = useMemo(() => readOptions(options), [options]);

	// The item id can come from options (resolved through the expression
	// engine, so it may reference a variable/field) or fall back to the part's
	// own field value. A direct `url` short-circuits the whole fetch.
	const itemId = useMemo(() => {
		if (opts.url) return undefined;
		const raw = opts.itemId ?? value;
		if (raw === undefined || raw === "") return undefined;
		const resolved = resolve(String(raw)).trim();
		return resolved === "" ? undefined : resolved;
	}, [opts.url, opts.itemId, value, resolve]);

	const [state, setState] = useState<LoadState>({ status: "idle" });

	useEffect(() => {
		if (opts.url || itemId === undefined) {
			setState({ status: "idle" });
			return;
		}
		const controller = new AbortController();
		setState({ status: "loading" });
		fetchDirectusAudioItem(itemId, fetch, controller.signal)
			.then((item) => setState({ status: "ready", item }))
			.catch((err: unknown) => {
				if (controller.signal.aborted) return;
				setState({
					status: "error",
					message: err instanceof Error ? err.message : String(err),
				});
			});
		return () => controller.abort();
	}, [opts.url, itemId]);

	const src = opts.url ?? (state.status === "ready" ? state.item.url : undefined);
	const title =
		opts.title ??
		(state.status === "ready"
			? (state.item.full_title ?? state.item.title)
			: undefined);
	const subtitles = state.status === "ready" ? state.item.subtitles : undefined;

	return (
		<figure className="classicyHyperCardDirectusAudio">
			{title && <figcaption className="classicyHyperCardDirectusAudioTitle">{title}</figcaption>}
			<AudioBody
				src={src}
				title={title}
				subtitles={subtitles ?? undefined}
				autoPlay={opts.autoPlay}
				loop={opts.loop}
				preload={opts.preload}
				controls={!locked}
				loading={state.status === "loading"}
				error={state.status === "error" ? state.message : undefined}
				empty={!src && state.status === "idle"}
			/>
		</figure>
	);
};

interface AudioBodyProps {
	src?: string;
	title?: string;
	subtitles?: string;
	autoPlay?: boolean;
	loop?: boolean;
	preload?: "none" | "metadata" | "auto";
	controls: boolean;
	loading: boolean;
	error?: string;
	empty: boolean;
}

function AudioBody({
	src,
	title,
	subtitles,
	autoPlay,
	loop,
	preload,
	controls,
	loading,
	error,
	empty,
}: AudioBodyProps) {
	const ref = useRef<HTMLAudioElement>(null);

	// A locked part hides the native transport; still let a script-driven or
	// autoplaying clip run to completion by starting it on mount.
	useEffect(() => {
		if (!controls && autoPlay && ref.current) void ref.current.play().catch(() => {});
	}, [controls, autoPlay, src]);

	if (error) {
		return <p className="classicyHyperCardDirectusAudioMessage" role="alert">Could not load audio — {error}</p>;
	}
	if (loading) {
		return <p className="classicyHyperCardDirectusAudioMessage">Loading audio…</p>;
	}
	if (empty || !src) {
		return <p className="classicyHyperCardDirectusAudioMessage">No audio source</p>;
	}
	return (
		<audio
			ref={ref}
			className="classicyHyperCardDirectusAudioPlayer"
			src={src}
			controls={controls}
			autoPlay={autoPlay}
			loop={loop}
			preload={preload}
			aria-label={title ? `Audio: ${title}` : "Audio clip"}
		>
			{/* Captions track is always present for accessibility; `src` is
			    omitted (rendering an empty track) when the clip has none. */}
			<track kind="captions" src={subtitles || undefined} label="Captions" />
		</audio>
	);
}
