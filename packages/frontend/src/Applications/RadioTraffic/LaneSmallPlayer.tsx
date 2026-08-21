// The small player: what a folded lane shows INSTEAD of hiding its clips.
//
// Collapsing UPCOMING or PREVIOUS used to empty the lane, which threw away the
// one thing a listener collapses a lane to keep — a readable list of what is
// coming and what just went by. Figma's "Upcoming Row Players Collapsed" frame
// answers that with a compact card carrying five facts and no controls:
//
//   the subject, in quotes    what the clip is about
//   the tag chips             coloured by namespace, exactly as the card's
//                             Details panel colours them (tabs/tagPalette)
//   the start                 9/11/2001 8:33 AM ET
//   the duration              68 seconds
//   the link type             Conference Call
//
// No waveform, no transport, no tabs — a collapsed lane is a reference, not an
// instrument, and every control it dropped is still one expand away.
//
// A view over props like TrafficCard, and for the same reason: the shell owns
// the metadata map and the display offset, so this file learns about neither.
// It is NOT a variant of TrafficCard — they share no geometry, no chrome and no
// state, and folding them together would mean a card that renders nothing it
// was designed around.

import type React from "react";
import type { ItemMeta, MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import Marquee from "../radio-core/marquee";
import { useHorizontalOverflow } from "../radio-core/useHorizontalOverflow";
import { countdownFor } from "./cardStatus";
import styles from "./laneSmallPlayer.module.scss";
import { durationSecondsLabel, startLabel } from "./smallPlayerLabels";
import { itemTiming } from "./tabs/itemTiming";
import { chipColor, smallChipLabel } from "./tabs/tagPalette";

export interface LaneSmallPlayerProps {
	item: MediaItem;
	/** Absent for the items with no row in the mp3_meta frame. */
	meta?: ItemMeta;
	/** The desktop's display offset in hours (-4 on 2001-09-11). */
	tzOffsetHours: number;
	/**
	 * The virtual clock's current instant (true UTC, e.g. RadioTraffic's
	 * `anchorMs`) — read-only, threaded through to `startLabel` so it can drop
	 * the date when a clip started on the same display-shifted day the clock
	 * currently reads (issue #523). NOT the ms-precise seek clock: that ticks
	 * every render frame and would invalidate every folded card's memoisation
	 * far more often than the day it's read for could actually change.
	 */
	currentMs: number | null;
	/**
	 * Whether an overflowing chip row may marquee-scroll (issue #522).
	 * Defaults to false so a bare `<LaneSmallPlayer>` — every existing test,
	 * and any future caller that forgets the prop — keeps the old clipped
	 * single row. RadioTraffic.tsx opts UPCOMING and PREVIOUS in and leaves
	 * LIVE out: LIVE's collapsed card sits above a mix a listener is actively
	 * scanning, and a scrolling tag row there would be one more thing moving
	 * on a card whose whole point is "not the busy view".
	 */
	enableMarquee?: boolean;
}

export const LaneSmallPlayer: React.FC<LaneSmallPlayerProps> = ({
	item,
	meta,
	tzOffsetHours,
	currentMs,
	enableMarquee = false,
}) => {
	const timing = itemTiming(item);
	// The same fallback the full card uses: an untranscribed clip still has a
	// title, and a blank quote would read as a rendering fault.
	const subject = meta?.subject?.trim() || item.full_title;
	const start = startLabel(timing.startMs, tzOffsetHours, currentMs);
	const duration = durationSecondsLabel(timing.durationSec);
	const link = meta?.link?.trim();
	const tags = meta?.tags ?? [];
	const { containerRef, contentRef, overflowing } = useHorizontalOverflow();

	/**
	 * Time remaining until this clip's `start_date` — "59s" under a minute,
	 * "MM:SS" beyond it, "HH:MM:SS" from an hour out (cardStatus.countdownFor,
	 * the same rendering the UPCOMING lane's full-card badge already uses).
	 * Dropped once the start has passed rather than pinned at "0s": a LIVE or
	 * PREVIOUS clip's collapsed player has nothing left to count down to, same
	 * as the `start`/`duration`/`link` lines above are each dropped when the
	 * fact they carry is absent rather than printed empty.
	 */
	const startCountdown =
		currentMs !== null && timing.startMs !== null && timing.startMs > currentMs
			? countdownFor(item, currentMs)
			: null;

	const chipList = (
		<ul
			ref={enableMarquee ? contentRef : undefined}
			className={styles.rtSmallChips}
			aria-label="Tags"
		>
			{tags.map((tag) => (
				// mp3_tags.color is NULL on every row today, so the namespace
				// palette is what actually paints these; chipColor honours a
				// curator's colour first if one is ever set. Same call the
				// Details panel makes, so the two can never drift.
				<li
					key={tag.tag}
					className={styles.rtSmallChip}
					data-namespace={tag.namespace}
					style={{ background: chipColor(tag) }}
				>
					{smallChipLabel(tag)}
				</li>
			))}
		</ul>
	);

	return (
		<article className={styles.rtSmallPlayer} data-small-player={item.id}>
			{/* `title` gives the untruncated subject on hover — the line ellipsises. */}
			<h3 className={styles.rtSmallSubject} data-field="subject" title={subject}>
				{`${subject}`}
			</h3>

			{tags.length > 0 &&
				(enableMarquee ? (
					<div ref={containerRef} className={styles.rtSmallChipsWrapper}>
						{overflowing ? (
							<Marquee direction="left" speed={20} pauseOnHover gradient={false}>
								{chipList}
							</Marquee>
						) : (
							chipList
						)}
					</div>
				) : (
					chipList
				))}

			<div className={styles.rtSmallFooter}>
				<div className={styles.rtSmallTimings}>
					{/* Each line is dropped rather than printed empty: an absent
					    duration is a fact about the row, not about the recording. */}
					{start && (
						<span className={styles.rtSmallTiming} data-field="start">
							{start}
						</span>
					)}
					{duration && (
						<span className={styles.rtSmallTiming} data-field="duration">
							{duration}
						</span>
					)}
				</div>
				{(startCountdown || link) && (
					<div className={styles.rtSmallLinkGroup}>
						{startCountdown && (
							<span className={styles.rtSmallCountdown} data-field="countdown">
								{startCountdown}
							</span>
						)}
						{link && (
							<span className={styles.rtSmallLink} data-field="link" title={link}>
								{link}
							</span>
						)}
					</div>
				)}
			</div>
		</article>
	);
};
