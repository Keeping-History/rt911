import { useClassicyBalloonHelp } from "classicy";
import type React from "react";
import { useRef } from "react";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import styles from "./TV.module.scss";
import type { useThumbnailReorder } from "./useThumbnailReorder";

type ReorderHandlers = ReturnType<
	ReturnType<typeof useThumbnailReorder>["handlers"]
>;

/**
 * Balloon copy for a thumbnail, exact to its current context: in MultiView a
 * click toggles grid membership (and the verb depends on whether the channel
 * is in the grid right now); in single view it focuses the channel (unless it
 * already is the one playing). Dragging reorders in every mode.
 */
export function thumbnailBalloonContent(args: {
	source: string | undefined;
	multiSelectMode: boolean;
	isActive: boolean;
	isSelected: boolean;
}): string {
	const name = args.source ?? "this channel";
	const drag = "Click and drag to move it elsewhere in the channel order.";
	if (args.multiSelectMode) {
		return args.isSelected
			? `Click to remove ${name} from the MultiView grid. ${drag}`
			: `Click to add ${name} to the MultiView grid. ${drag}`;
	}
	return args.isActive
		? `You are watching ${name} now. ${drag}`
		: `Click to switch to ${name}. ${drag}`;
}

interface ThumbnailTileProps {
	item: MediaItem;
	className: string;
	multiSelectMode: boolean;
	isActive: boolean;
	isSelected: boolean;
	/** 30s-bucketed virtual-clock timestamp the strip's thumbnails refresh on. */
	thumbTs: number;
	reorderHandlers: ReorderHandlers | undefined;
	/** Whether a drag just ended, in which case the click must be swallowed. */
	consumeSuppressedClick: () => boolean;
	/** Focus the channel, or toggle its grid membership in MultiView. */
	onPress: () => void;
}

/**
 * One thumbnail-strip tile. The balloon rides on the <button> itself via
 * useClassicyBalloonHelp rather than a <ClassicyBalloonHelp> wrapper:
 * useThumbnailReorder resolves drop targets by walking the strip's direct
 * children for data-source, so the buttons must stay direct children of the
 * strip — the wrapper's anchor <div> would break dragging.
 */
export function ThumbnailTile({
	item,
	className,
	multiSelectMode,
	isActive,
	isSelected,
	thumbTs,
	reorderHandlers,
	consumeSuppressedClick,
	onPress,
}: ThumbnailTileProps) {
	const anchorRef = useRef<HTMLButtonElement>(null);
	const { handlers: balloonHandlers, balloon } = useClassicyBalloonHelp(
		anchorRef,
		{
			content: thumbnailBalloonContent({
				source: item.source,
				multiSelectMode,
				isActive,
				isSelected,
			}),
		},
	);

	return (
		<>
			<button
				ref={anchorRef}
				data-source={item.source}
				className={className}
				{...(reorderHandlers ?? {})}
				{...balloonHandlers}
				onPointerDown={(e: React.PointerEvent<HTMLButtonElement>) => {
					// A press starts a click or a drag; the balloon accompanies neither.
					balloonHandlers.onMouseLeave();
					reorderHandlers?.onPointerDown(e);
				}}
				onClick={() => {
					// A drag just ended — it must not focus or select.
					if (consumeSuppressedClick()) return;
					onPress();
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") onPress();
				}}
				type="button"
			>
				<div className={styles.tvChannelTitleHolder}>
					<p className={styles.tvChannelTitle}>{item.source}</p>
				</div>
				<img
					className={styles.tvThumbnailImage}
					src={`https://files.911realtime.org/thumbnails/${
						item.source?.toLowerCase() ?? "offline"
					}/${thumbTs}.jpg`}
					onError={(e) => {
						e.currentTarget.src =
							"https://files.911realtime.org/thumbnails/offline.jpg";
					}}
					alt=""
				/>
			</button>
			{balloon}
		</>
	);
}
