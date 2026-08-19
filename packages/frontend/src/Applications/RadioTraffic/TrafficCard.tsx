// One traffic card — header, waveform, control bar, tabs — at 1.25x Figma's
// 210x124 frame (see --rt-card-scale in trafficCard.module.scss).
//
// A view over props, not a reader of app state. Everything it needs — which
// lane it is in, what the clock reads, whether it is in the mix — arrives from
// the shell, so the lane containers (Step 18) and the audio orchestration
// (Step 19) can wire it without this file learning about either. The one thing
// it reaches for directly is audioCoordinator: the elements live there precisely
// because a card mounting and unmounting must not decide whether a clip is
// playing. It READS its playhead from there, and makes exactly two writes —
// seekTo when the listener scrubs the waveform, and unfollowClock when they stop
// the card — both of which are statements about ONE item, which is the thing a
// card is and the shell is not.
//
// What it derives rather than takes:
//
//   badge        badgeFor(lane, clock, element position) — Step 9's rules.
//                The lane itself is a prop: Step 18 partitions items with
//                laneFor to decide which lane a card goes in, and a card that
//                recomputed it would be a second answer free to disagree with
//                the container it is sitting in.
//   livePct      the clock's position over the clip's duration, 0..1.
//   currentPct   the playhead over the same, 0..1 — the element's position when
//                there is an element, the clock's when there is not (story 028).

import type React from "react";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import type { ItemMeta, MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import { PeaksWaveform } from "../radio-core/PeaksWaveform";
import { calcSeekSeconds } from "../radio-core/stationGrouping";
import { positionMs, seekTo, subscribe, unfollowClock } from "./audioCoordinator";
import { type Badge, badgeFor, countdownFor, type Lane } from "./cardStatus";
import { CARD_TABS, CardTabBar, visibleCardTabs } from "./CardTabBar";
import { itemTiming } from "./tabs/itemTiming";
import styles from "./trafficCard.module.scss";

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
	/** Whether the mix has this card silenced. Drives the mute button's own state. */
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
	/**
	 * Flip THIS card's mute. Optional only because the shell that owns the mix
	 * (RadioTraffic's AudioState) has yet to hand it down; the button is rendered
	 * either way so the control and its state never disagree about existing.
	 */
	onToggleMute?: () => void;
}

/**
 * The mute button's artwork, in the two states it has.
 *
 * Inline rather than an <img> because it has to take its colour from the card it
 * is sitting on — an audible LIVE card and a grayed-out UPCOMING one paint the
 * same speaker in different inks, and `currentColor` is how one asset does that.
 */
const SpeakerIcon: React.FC<{ muted: boolean }> = ({ muted }) => (
	<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" role="presentation">
		<path d="M2 6h3l4-3.5v11L5 10H2z" fill="currentColor" />
		{muted ? (
			<path d="M11 6l4 4M15 6l-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" />
		) : (
			<path
				d="M11 5.5a3.5 3.5 0 0 1 0 5M13.5 3.5a6.5 6.5 0 0 1 0 9"
				stroke="currentColor"
				strokeWidth="1.5"
				fill="none"
			/>
		)}
	</svg>
);

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
	onToggleMute,
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

	// Only offered when the clip's length is known: without one there is no map
	// from a fraction of the envelope to an instant in the recording, and a click
	// would have to invent the instant it seeks to.
	const onSeekPct = useCallback(
		(pct: number) => {
			seekTo(item.id, pct * durationMs);
		},
		[item.id, durationMs],
	);

	// Pressing pause is the listener taking this card off the clock — a stopped
	// card's playhead stays where they stopped it rather than running on ahead of
	// the silence. Pressing play is the opposite, and needs nothing here: the
	// shell registers a fresh element, which is what puts the card back on.
	const onTransport = useCallback(() => {
		if (!paused) unfollowClock(item.id);
		onTogglePause();
	}, [paused, item.id, onTogglePause]);

	const title = meta?.subject?.trim() || item.full_title;
	// Summary is only offered when there is one, so the tab list is a fact about
	// THIS item rather than a constant. The panel is looked up in the same list
	// the bar draws, and the bar is told which tab that lookup landed on: an item
	// whose summary goes away while its Summary tab is open then falls back to
	// Details with Details highlighted, rather than showing one and marking none.
	const tabs = useMemo(() => visibleCardTabs(meta), [meta]);
	const panel = tabs.find((tab) => tab.id === active) ?? tabs[0];

	// The one thing the design signals with brightness: not "is this card
	// running" but "is this one of the clips you are hearing". Both halves are
	// needed — a muted clip still advances (audioCoordinator silences rather than
	// pauses, so it stays in sync) and a paused one is not making a sound at all.
	// UPCOMING is excluded outright because it has no audio yet, which is the same
	// rule toolMode.isAudible states for the mix.
	const audible = lane !== "upcoming" && !paused && !muted;

	return (
		<article
			className={styles.rtCard}
			data-lane={lane}
			data-item={item.id}
			// The stylesheet's key for the brightness/saturation lift. An attribute
			// rather than a class so the CSS reads as one table of lane x audible.
			data-audible={audible}
		>
			{/* The lane is repeated here so the header's colour has a selector of its
			    own to hang off. It is the same prop the card frame carries, not a
			    second derivation, so the two cannot come to disagree. */}
			<header className={styles.rtCardHeader} data-card-header data-lane={lane}>
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
			    need — it renders a bare fragment and establishes none of its own.
			    The slot's own height is the stylesheet's, as a proportion of the
			    card, so no number here sizes the canvas. */}
			<div
				className={styles.rtCardWaveform}
				data-card-waveform
				style={waveformColor ? { color: waveformColor } : undefined}
				// The lane slot and the card slot above apply the active tool on
				// pointerup. Left to bubble, letting go of a scrub under the mute
				// tool would seek AND mute — the same collision the mute button
				// already guards against.
				onPointerUp={(e) => e.stopPropagation()}
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
					livePct={livePct}
					currentPct={currentPct}
					onSeekPct={durationMs > 0 ? onSeekPct : undefined}
				/>
			</div>

			<div className={styles.rtCardControls}>
				<button
					type="button"
					className={styles.rtCardTransport}
					aria-label={paused ? "Play" : "Pause"}
					title={paused ? "Play" : "Pause"}
					onClick={onTransport}
				>
					<span aria-hidden="true">{paused ? "▶" : "❚❚"}</span>
				</button>
				<button
					type="button"
					className={styles.rtCardMute}
					data-muted={muted}
					// Named for what the press does, not for the state it is in: a
					// button called "Muted" reads to a screen reader as an instruction
					// to mute. aria-pressed carries the state.
					aria-label={muted ? "Unmute" : "Mute"}
					aria-pressed={muted}
					title={muted ? "Unmute" : "Mute"}
					onClick={onToggleMute}
					// The lane slot and the card slot above both apply the active tool
					// on pointerup (LaneSection, RadioTraffic's renderCard). Left to
					// bubble, one press on this button under the mute tool would mute
					// via the tool AND toggle via the button — two edits from one click,
					// which reads as the button not working.
					onPointerUp={(e) => e.stopPropagation()}
				>
					<SpeakerIcon muted={muted} />
				</button>
			</div>

			<div className={styles.rtCardTabs}>
				<CardTabBar tabs={tabs} active={panel.id} onSelect={setActive} />
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
