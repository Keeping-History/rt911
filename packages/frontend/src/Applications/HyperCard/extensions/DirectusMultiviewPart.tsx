import type { HyperCardPartProps } from "classicy";
import { useMemo, useState } from "react";
import { DirectusVideo } from "./DirectusVideoPart";
import { type DirectusVideoOptions, readVideoOptions } from "./videoOptions";
import "./DirectusMultiviewPart.css";

/**
 * `directusMultiview` HyperCard part — a grid of TV channel streams (a "video
 * wall"). Each tile takes the full `directusVideo` option set.
 *
 *   { "id": "wall", "type": "directusMultiview", "rect": [8, 32, 404, 236],
 *     "options": {
 *       "audio": "solo",          // "solo" | "all" | "mute"
 *       "columns": 2,             // omit for an automatic grid
 *       "videos": [
 *         { "channelId": 1, "autoPlay": true },
 *         { "channelId": 2, "autoPlay": true },
 *         { "channelId": 3, "start": "2001-09-11T12:46:00", "autoPlay": true }
 *       ]
 *     } }
 *
 * Audio modes: `solo` plays one tile's audio (tap a tile to switch), `mute`
 * silences every tile, `all` lets each tile use its own muted/volume options.
 */

type AudioMode = "solo" | "all" | "mute";

interface MultiviewOptions {
	videos: DirectusVideoOptions[];
	columns?: number;
	audio: AudioMode;
	/** Index of the tile audible first in `solo` mode. */
	active?: number;
}

function readMultiviewOptions(options: Record<string, unknown>): MultiviewOptions {
	const rawVideos = Array.isArray(options.videos) ? options.videos : [];
	const videos = rawVideos
		.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
		.map(readVideoOptions);
	const audio: AudioMode =
		options.audio === "all" || options.audio === "mute" ? options.audio : "solo";
	const columns =
		typeof options.columns === "number" && options.columns > 0
			? Math.floor(options.columns)
			: undefined;
	const active = typeof options.active === "number" ? Math.floor(options.active) : 0;
	return { videos, columns, audio, active };
}

/** Balanced column count for `n` tiles when the author doesn't set one. */
function autoColumns(n: number): number {
	return n <= 1 ? 1 : Math.ceil(Math.sqrt(n));
}

export const DirectusMultiviewPart = ({ options, partId, stackId }: HyperCardPartProps) => {
	const { videos, columns, audio, active } = useMemo(
		() => readMultiviewOptions(options),
		[options],
	);
	const [activeIndex, setActiveIndex] = useState(active);

	if (videos.length === 0) {
		return (
			<div className="classicyHyperCardMultiview classicyHyperCardMultiviewEmpty">
				No videos configured
			</div>
		);
	}

	const cols = Math.min(columns ?? autoColumns(videos.length), videos.length);

	return (
		<div
			className="classicyHyperCardMultiview"
			style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
		>
			{videos.map((v, i) => {
				const forceMuted = audio === "mute" ? true : audio === "solo" ? i !== activeIndex : undefined;
				const solo = audio === "solo";
				return (
					<div
						key={i}
						className={
							"classicyHyperCardMultiviewTile" +
							(solo && i === activeIndex ? " classicyHyperCardMultiviewTileActive" : "")
						}
					>
						<DirectusVideo
							{...v}
							appId={`hc-${stackId}-${partId}-${i}`}
							// A muted wall usually wants the transport hidden unless the
							// author explicitly asked for controls on a tile.
							controls={v.controls === true}
							forceMuted={forceMuted}
							onActivate={solo ? () => setActiveIndex(i) : undefined}
						/>
					</div>
				);
			})}
		</div>
	);
};
