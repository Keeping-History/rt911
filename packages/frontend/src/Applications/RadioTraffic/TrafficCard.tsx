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

import { ClassicyBevelButton } from "classicy";
import type React from "react";
import {
	memo,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import type { ItemMeta, MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import { PeaksWaveform } from "../radio-core/PeaksWaveform";
import { calcSeekSeconds } from "../radio-core/stationGrouping";
import {
	hasEnded,
	positionMs,
	resetPlayback,
	seekTo,
	subscribe,
	unfollowClock,
} from "./audioCoordinator";
import { type Badge, badgeFor, countdownFor, type Lane } from "./cardStatus";
import { isSilentAt } from "./silence";
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
	 * The listener scrubbed the waveform — LIVE only (see RadioTraffic.tsx's
	 * renderCard). Fired in addition to the seek itself, not instead of it: this
	 * is purely a signal for Story 045's manual hold, and carries no position of
	 * its own for the shell to act on.
	 */
	onManualSeek?: () => void;
	/**
	 * The listener switched this card's tab — LIVE only (see RadioTraffic.tsx's
	 * renderCard), the same signal `onManualSeek` sends for a scrub. A listener
	 * reading through a card's tabs is exactly the "actively touching it" Story
	 * 045's hold exists to detect, so this fires alongside the panel switch
	 * rather than instead of it.
	 */
	onTabSelect?: () => void;
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

/**
 * A circular arrow open at the top, with an arrowhead at its left end — the
 * rewind-to-start button's artwork. `currentColor`, same reasoning as the
 * speaker: one asset has to read on both a bright LIVE card and a dimmed
 * UPCOMING one.
 */
const RewindIcon: React.FC = () => (
	<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" role="presentation">
		<path
			d="M8 2.5a5.5 5.5 0 1 1 -5.5 5.5"
			stroke="currentColor"
			strokeWidth="1.5"
			fill="none"
			strokeLinecap="round"
		/>
		<path
			d="M5 5.3L2 8l3 2.7"
			stroke="currentColor"
			strokeWidth="1.5"
			fill="none"
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
	</svg>
);

/**
 * A broadcast glyph — a filled dot inside a signal arc — for the sync-to-live
 * button. `currentColor`, same treatment as RewindIcon: one asset has to read
 * on both a bright LIVE card and a dimmed, disabled one.
 */
const LiveSyncIcon: React.FC = () => (
	<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" role="presentation">
		<circle cx="8" cy="8" r="1.8" fill="currentColor" />
		<path
			d="M5.6 5.6a3.3 3.3 0 0 0 0 4.8M10.4 5.6a3.3 3.3 0 0 1 0 4.8"
			stroke="currentColor"
			strokeWidth="1.4"
			fill="none"
			strokeLinecap="round"
		/>
		<path
			d="M3.3 3.3a6.6 6.6 0 0 0 0 9.4M12.7 3.3a6.6 6.6 0 0 1 0 9.4"
			stroke="currentColor"
			strokeWidth="1.4"
			fill="none"
			strokeLinecap="round"
		/>
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
		case "silence":
			return "Silence";
	}
}

const TrafficCardImpl: React.FC<TrafficCardProps> = ({
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
	onManualSeek,
	waveformColor,
	onToggleMute,
	onTabSelect,
}) => {
	const [active, setActive] = useState(CARD_TABS[0].id);

	// The element's position is external state that changes on `timeupdate`, not
	// on render, so it is read through the coordinator's own subscription rather
	// than mirrored into React state by an effect. positionMs returns a number
	// (or undefined), which is a snapshot stable by value — exactly what
	// useSyncExternalStore needs.
	const watchItem = useCallback(
		(onChange: () => void) => subscribe(item.id, onChange),
		[item.id],
	);
	const currentMs = useSyncExternalStore(
		watchItem,
		useCallback(() => positionMs(item.id), [item.id]),
	);
	// The other thing the element knows and nothing else does: the recording ran
	// out. Same subscription, because the coordinator notifies on `ended` as it
	// does on every other media event; a separate snapshot because it is a
	// separate fact, and a boolean is stable by value exactly as the position is.
	const ended = useSyncExternalStore(
		watchItem,
		useCallback(() => hasEnded(item.id), [item.id]),
	);

	const durationMs = (itemTiming(item).durationSec ?? 0) * 1000;
	// badgeFor (cardStatus.ts) never reads liveMs for "upcoming" (returns on
	// `countdown` alone) or "previous" (returns on `userPlaying`/`silent` alone)
	// — only the LIVE-lane drift calculation uses it. calcSeekSeconds parses
	// item.start_date through `new Date(...)` on every call, so computing it
	// unconditionally was real, provably-wasted work on every UPCOMING/PREVIOUS
	// card, every render — the two lanes with the most cards once a session has
	// been running a while.
	const liveMs = lane === "live" ? calcSeekSeconds(item, nowMs) * 1000 : 0;

	// One tick of history, held here rather than in cardStatus so badgeFor stays
	// a pure function of its arguments — see BadgeArgs.previousKind.
	const previousKind = useRef<Badge["kind"] | undefined>(undefined);

	// Read from the peaks envelope this card already draws: no fetch, no
	// analyser. Undefined peaks mean "unknown", which isSilentAt reports as not
	// silent — a card with no envelope never claims the tape is quiet.
	const silent = isSilentAt({
		peaks: meta?.peaks,
		durationMs,
		positionMs: currentMs,
	});

	const badge = badgeFor({
		lane,
		liveMs,
		silent,
		previousKind: previousKind.current,
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

	// Recorded after render so the NEXT tick can widen or tighten the deadband.
	// An effect rather than a write during render: badgeFor must see the value
	// from the previous committed render, not one this render already moved.
	useEffect(() => {
		previousKind.current = badge?.kind;
	}, [badge?.kind]);

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
			onManualSeek?.();
		},
		[item.id, durationMs, onManualSeek],
	);

	// The rewind button: the same write the waveform's own left edge would make
	// (seekTo already clamps to 0 and floors negative input, so this is not a
	// special case of it), reported through the same onManualSeek signal a
	// scrub uses — a deliberate rewind is exactly the kind of press that should
	// take a LIVE card off the clock's own hold the way a scrub does.
	const onRewind = useCallback(() => {
		seekTo(item.id, 0);
		onManualSeek?.();
	}, [item.id, onManualSeek]);

	/**
	 * Sync back live (issue #537 item 2): seek the element to where the virtual
	 * clock says the audio should be right now — `liveMs`, the same number the
	 * drift badge above is computed from — and, if the listener had stopped this
	 * card, resume it. Reported through onManualSeek exactly like the rewind
	 * button: a deliberate resync is exactly the kind of press that should count
	 * as a touch under Story 045's hold.
	 *
	 * Disabled (see the button below) whenever there is nowhere sensible to sync
	 * TO — off the LIVE lane, a clip with no known duration, or a LIVE clip the
	 * clock has already run past the end of — so the press is never offered a
	 * position that does not exist.
	 */
	const onSyncLive = useCallback(() => {
		seekTo(item.id, liveMs);
		onManualSeek?.();
		if (paused) onTogglePause();
	}, [item.id, liveMs, onManualSeek, paused, onTogglePause]);
	const syncLiveDisabled = lane !== "live" || durationMs <= 0 || liveMs > durationMs;

	// Stopping means opposite things in the two lanes that can be playing.
	//
	// A LIVE card is running on the virtual clock, so the listener stopping it is
	// them taking it OFF the clock: its playhead stays where they stopped it
	// rather than running on ahead of the silence (story 028).
	//
	// A PREVIOUS clip is a replay they started by hand and are now finished with,
	// so stopping it is a reset (story 038): parking it would leave the card
	// showing progress it is no longer making, and the next press of play starts
	// the recording from the top regardless.
	//
	// Pressing play needs neither: the shell registers a fresh element, which is
	// what hands the card back to the clock.
	const stopPlayback = useCallback(() => {
		if (lane === "previous") resetPlayback(item.id);
		else unfollowClock(item.id);
	}, [lane, item.id]);

	const onTransport = useCallback(() => {
		if (!paused) stopPlayback();
		onTogglePause();
	}, [paused, stopPlayback, onTogglePause]);

	// Story 038: the end of a listener-started PREVIOUS clip.
	//
	// It is the one playback in the app that finishes while its card stays put —
	// a LIVE clip is over when the CLOCK says so and the lane moves the card with
	// it — so nothing else was watching, and the card kept its Playing badge and
	// its pause affordance indefinitely. Reaching the end is the listener's stop
	// happening without them, so it does exactly what their stop does.
	//
	// Latched, because the hand-back is a TOGGLE: the shell owns one `userStarted`
	// set and one way to change it, so a second call would stop the clip and
	// immediately start it playing again. `resetPlayback` releases the element, so
	// `ended` goes false and the latch re-arms for the next play.
	const handedBack = useRef(false);
	useEffect(() => {
		if (!ended) {
			handedBack.current = false;
			return;
		}
		// `userPlaying` is the listener's own playback and nothing else; the lane
		// is checked too because a backward seek can carry a started clip back
		// into LIVE, where `onTogglePause` means "stop the live card" instead.
		if (lane !== "previous" || !userPlaying || handedBack.current) return;
		handedBack.current = true;
		stopPlayback();
		onTogglePause();
	}, [ended, lane, userPlaying, stopPlayback, onTogglePause]);

	const title = meta?.subject?.trim() || item.full_title;
	// visibleCardTabs offers every tab today (story 049) — the seam stays
	// because the panel is looked up in the same list the bar draws, and the
	// bar is told which tab that lookup landed on, which is what lets a tab
	// that genuinely does depend on the item fall back to Details with Details
	// highlighted instead of showing a panel with nothing selected.
	const tabs = useMemo(() => visibleCardTabs(meta), [meta]);
	const panel = tabs.find((tab) => tab.id === active) ?? tabs[0];

	// The existing panel switch, plus Story 045's touch signal alongside it —
	// see onTabSelect above.
	const handleTabSelect = useCallback(
		(id: string) => {
			setActive(id);
			onTabSelect?.();
		},
		[onTabSelect],
	);

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
			// Story 041's dimmed chrome keys off this alongside data-audible.
			data-silent={silent}
		>
			{/* The lane is repeated here so the header's colour has a selector of its
			    own to hang off. It is the same prop the card frame carries, not a
			    second derivation, so the two cannot come to disagree. */}
			{/* Issue #537: the ONLY interaction that solos/mutes-toggles this card
			    via the active tool, or steals focus from another Live card, is a
			    click here — the shell's `rtCardSlot` wrapper (RadioTraffic.tsx)
			    scopes its pointerup to this element specifically, so a click
			    anywhere else in the card, including the CardTabBar tabs below
			    (which used to bubble a pointerup all the way up to the same
			    handler), does not fire the same toggle. That scoping lives on the
			    wrapper, outside this memo'd component, rather than as a prop here:
			    the toggle's behavior depends on the active tool, which this card
			    deliberately does not re-render for (see propsAreEqual below), so a
			    closure passed in as a prop would go stale the moment the tool
			    changed without also changing one of the props actually compared. */}
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
				<ClassicyBevelButton
					square
					bevelWidth="small"
					data-card-transport
					aria-label={paused ? "Play" : "Pause"}
					title={paused ? "Play" : "Pause"}
					onClickFunc={onTransport}
				>
					<span aria-hidden="true">{paused ? "▶" : "❚❚"}</span>
				</ClassicyBevelButton>
				<ClassicyBevelButton
					square
					bevelWidth="small"
					data-card-rewind
					aria-label="Rewind to start"
					title="Rewind to start"
					onClickFunc={onRewind}
					// Same collision the mute button and the waveform already guard
					// against: left to bubble, letting go of a rewind press under the
					// mute tool would rewind AND mute the card in one release.
					onPointerUp={(e) => e.stopPropagation()}
				>
					<RewindIcon />
				</ClassicyBevelButton>
				<ClassicyBevelButton
					square
					bevelWidth="small"
					data-card-sync-live
					disabled={syncLiveDisabled}
					aria-label="Sync back live"
					title="Sync back live"
					onClickFunc={onSyncLive}
					// Same collision every other control in this row already guards
					// against — left to bubble, letting go of a resync press would
					// also fire whatever the active tool does to the card underneath.
					onPointerUp={(e) => e.stopPropagation()}
				>
					<LiveSyncIcon />
				</ClassicyBevelButton>
				<ClassicyBevelButton
					mode="toggle"
					square
					bevelWidth="small"
					// Controlled: the mix's own mute is the single source of truth (the
					// card is a view over props, not a second copy of it), and toggle
					// mode is what gives this its own aria-pressed for free.
					on={muted}
					data-card-mute
					data-muted={muted}
					// Named for what the press does, not for the state it is in: a
					// button called "Muted" reads to a screen reader as an instruction
					// to mute. aria-pressed is ClassicyBevelButton's own, computed from
					// `on` — the same fact `muted` carries.
					aria-label={muted ? "Unmute" : "Mute"}
					title={muted ? "Unmute" : "Mute"}
					onChangeFunc={onToggleMute}
					// The lane slot and the card slot above both apply the active tool
					// on pointerup (LaneSection, RadioTraffic's renderCard). Left to
					// bubble, one press on this button under the mute tool would mute
					// via the tool AND toggle via the button — two edits from one click,
					// which reads as the button not working.
					onPointerUp={(e) => e.stopPropagation()}
				>
					<SpeakerIcon muted={muted} />
				</ClassicyBevelButton>
			</div>

			<div className={styles.rtCardTabs}>
				<CardTabBar tabs={tabs} active={panel.id} onSelect={handleTabSelect} />
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

/**
 * `onTogglePause`/`onManualSeek`/`onToggleMute`/`onTabSelect` are fresh
 * closures on every RadioTraffic render — `renderCard` (RadioTraffic.tsx) is
 * invoked anew per render, not cached per item — but each one only ever does
 * something with THIS card's own `item.id`/`lane`, which are already compared
 * below. Ignoring them here, rather than requiring the shell to stabilize
 * four per-item callbacks, is what lets `memo` actually skip the other ~30+
 * cards' full render (waveform draw, tab-bar overflow measurement, …) when a
 * change affects only one card, or nothing about any card at all — e.g.
 * selecting a different tool in the palette, which no prop here depends on.
 * (The active-tool click itself is scoped to the header row by the shell's
 * wrapper, outside this memo, for exactly this reason — see the header's own
 * comment above.)
 */
function propsAreEqual(prev: TrafficCardProps, next: TrafficCardProps): boolean {
	return (
		prev.item === next.item &&
		prev.meta === next.meta &&
		prev.lane === next.lane &&
		prev.tzOffsetHours === next.tzOffsetHours &&
		// PREVIOUS never reads nowMs — badgeFor's "previous" branch answers off
		// userPlaying/silent alone, and liveMs is hardcoded to 0 off this lane.
		// Comparing it anyway forced every idle back-catalogue card (up to
		// PREVIOUS_LANE_LIMIT of them) to fully re-render on every clock tick for
		// an output that could not have changed.
		(next.lane === "previous" || prev.nowMs === next.nowMs) &&
		prev.seeking === next.seeking &&
		prev.userPlaying === next.userPlaying &&
		prev.muted === next.muted &&
		prev.paused === next.paused &&
		prev.waveformColor === next.waveformColor
	);
}

export const TrafficCard = memo(TrafficCardImpl, propsAreEqual);
