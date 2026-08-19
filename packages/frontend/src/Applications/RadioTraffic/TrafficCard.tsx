// One 210x124 traffic card: header, waveform, control bar, tabs.
//
// A view over props, not a reader of app state. Everything it needs — which
// lane it is in, what the clock reads, whether it is in the mix — arrives from
// the shell, so the lane containers (Step 18) and the audio orchestration
// (Step 19) can wire it without this file learning about either. The one thing
// it reaches for directly is audioCoordinator, and only to READ: the elements
// live there precisely because a card mounting and unmounting must not decide
// whether a clip is playing.
//
// What it derives rather than takes:
//
//   badge        badgeFor(lane, clock, element position) — Step 9's rules.
//                The lane itself is a prop: Step 18 partitions items with
//                laneFor to decide which lane a card goes in, and a card that
//                recomputed it would be a second answer free to disagree with
//                the container it is sitting in.
//   livePct      the clock's position over the clip's duration, 0..1.
//   currentPct   the element's position over the same, 0..1.

import type React from "react";
import { useCallback, useState, useSyncExternalStore } from "react";
import type { ItemMeta, MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import { PeaksWaveform } from "../radio-core/PeaksWaveform";
import { calcSeekSeconds } from "../radio-core/stationGrouping";
import { positionMs, subscribe } from "./audioCoordinator";
import { type Badge, badgeFor, countdownFor, type Lane } from "./cardStatus";
import { CARD_TABS, CardTabBar } from "./CardTabBar";
import { itemTiming } from "./tabs/itemTiming";
import styles from "./trafficCard.module.scss";

/** Figma's waveform slot is 27px tall; PeaksWaveform sizes its bitmap from it. */
const WAVEFORM_HEIGHT = 27;

export interface TrafficCardProps {
	item: MediaItem;
	/** Absent for the 59 of 814 items with no row in the mp3_meta frame. */
	meta?: ItemMeta;
	/** Which lane the card is sitting in, decided by the lane that holds it. */
	lane: Lane;
	/** The desktop's display offset in hours (-4 on 2001-09-11), for the panels. */
	tzOffsetHours: number;
	/** The virtual clock, in true UTC ms. */
	nowMs: number;
	/** A clock seek is in flight — the LIVE badge says so instead of reporting noise. */
	seeking?: boolean;
	/** PREVIOUS only: the listener started this clip themselves. */
	userPlaying?: boolean;
	/** Whether the mix has this card silenced. An indicator; the tools do the muting. */
	muted?: boolean;
	paused?: boolean;
	onTogglePause: () => void;
	/**
	 * The waveform's ink as a CSS color, or undefined to follow the theme.
	 *
	 * A `color` on the waveform slot rather than a prop passed into
	 * PeaksWaveform, because that is the seam PeaksWaveform already reads: it
	 * resolves `getComputedStyle(canvas).color` at draw time, which is why the
	 * envelope has always taken `.rtCardWaveform`'s `--color-system-06`. So the
	 * setting overrides an inherited value instead of introducing a second way
	 * to colour the same canvas.
	 */
	waveformColor?: string;
}

/** The badge, in the few characters the 196px header can spare beside a subject. */
function badgeLabel(badge: Badge): string {
	switch (badge.kind) {
		case "in-sync":
			return "In sync";
		case "seeking":
			return "Seeking";
		case "drift":
			// Signed, so a listener can tell a lagging element from a leading one.
			return `${badge.seconds > 0 ? "+" : ""}${badge.seconds}s`;
		case "countdown":
			return badge.label;
		case "playing":
			return "Playing";
	}
}

export const TrafficCard: React.FC<TrafficCardProps> = ({
	item,
	meta,
	lane,
	tzOffsetHours,
	nowMs,
	seeking = false,
	userPlaying = false,
	muted = false,
	paused = false,
	onTogglePause,
	waveformColor,
}) => {
	const [active, setActive] = useState(CARD_TABS[0].id);

	// The element's position is external state that changes on `timeupdate`, not
	// on render, so it is read through the coordinator's own subscription rather
	// than mirrored into React state by an effect. positionMs returns a number
	// (or undefined), which is a snapshot stable by value — exactly what
	// useSyncExternalStore needs.
	const currentMs = useSyncExternalStore(
		useCallback((onChange: () => void) => subscribe(item.id, onChange), [item.id]),
		useCallback(() => positionMs(item.id), [item.id]),
	);

	const durationMs = (itemTiming(item).durationSec ?? 0) * 1000;
	const liveMs = calcSeekSeconds(item, nowMs) * 1000;

	const badge = badgeFor({
		lane,
		liveMs,
		// No registered element means no sound, and zero is where such a card
		// stands as far as the listener is concerned. On a LIVE card that reads as
		// a large negative drift for the moment before `loadedmetadata` fires and
		// the coordinator seeks it to the clock — which is true, and settles
		// itself, rather than a comfortable lie about being in sync.
		currentMs: currentMs ?? 0,
		seeking,
		userPlaying,
		countdown: lane === "upcoming" ? countdownFor(item, nowMs) : undefined,
	});

	// FRACTIONS, 0..1 — PeaksWaveform's units, not percentages. A 0..100 value
	// clamps to 1 and parks both markers against the right edge.
	const fractionOf = (ms: number | undefined): number | undefined =>
		ms === undefined || durationMs <= 0 ? undefined : ms / durationMs;
	// Only a LIVE clip has a clock position inside it; on the other two lanes the
	// marker would claim a playhead that does not exist.
	const livePct = lane === "live" ? fractionOf(liveMs) : undefined;
	const currentPct = fractionOf(currentMs);

	const title = meta?.subject?.trim() || item.full_title;
	const panel = CARD_TABS.find((tab) => tab.id === active) ?? CARD_TABS[0];

	return (
		<article className={styles.rtCard} data-lane={lane} data-item={item.id}>
			<header className={styles.rtCardHeader}>
				{/* `title` gives the full subject on hover — the header ellipsises. */}
				<h3 className={styles.rtCardTitle} data-card-title title={title}>
					{title}
				</h3>
				{badge && (
					<span className={styles.rtCardBadge} data-badge={badge.kind}>
						{badgeLabel(badge)}
					</span>
				)}
			</header>

			{/* The positioned containing block PeaksWaveform's absolute scrubbers
			    need — it renders a bare fragment and establishes none of its own. */}
			<div
				className={styles.rtCardWaveform}
				data-card-waveform
				style={waveformColor ? { color: waveformColor } : undefined}
			>
				<PeaksWaveform
					// PeaksWaveform samples its ink once per draw, and it redraws
					// only when its peaks, its height or its layout width change — a
					// colour change is none of those, so without this the canvas
					// keeps the old ink until something else happens to resize it.
					// Keying it on the colour remounts the canvas, and a remount IS
					// the redraw. It costs one repaint per card, only at the moment
					// the listener picks a new colour.
					key={waveformColor ?? "theme"}
					peaks={meta?.peaks}
					height={WAVEFORM_HEIGHT}
					livePct={livePct}
					currentPct={currentPct}
				/>
			</div>

			<div className={styles.rtCardControls}>
				<button
					type="button"
					className={styles.rtCardTransport}
					aria-label={paused ? "Play" : "Pause"}
					title={paused ? "Play" : "Pause"}
					onClick={onTogglePause}
				>
					<span aria-hidden="true">{paused ? "▶" : "❚❚"}</span>
				</button>
				<span className={styles.rtCardLevel} data-muted={muted}>
					{muted ? "Muted" : "Audible"}
				</span>
			</div>

			<div className={styles.rtCardTabs}>
				<CardTabBar tabs={CARD_TABS} active={active} onSelect={setActive} />
				<div className={styles.rtCardPanel}>
					<panel.Panel
						item={item}
						meta={meta}
						tzOffsetHours={tzOffsetHours}
						// The element's own position, not the clock's: a drifting card
						// must caption the words it is actually saying.
						currentTimeSec={currentMs === undefined ? undefined : currentMs / 1000}
					/>
				</div>
			</div>
		</article>
	);
};
