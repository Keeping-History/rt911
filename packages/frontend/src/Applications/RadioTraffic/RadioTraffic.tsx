// The Radio Traffic app shell: the one place every other module in this folder
// is wired together, and the only one that holds state.
//
// Everything below it is a view over props — the palette, the filter tree, the
// lanes and the cards all report and never decide — so this file answers the
// three questions the app is made of:
//
//   which lane is a card in?   laneFor, over one merged catalogue (partitionLanes)
//   is it on screen?           matchesFilter, against the checked tag set
//   can it be heard?           isAudible, over the FILTER-VISIBLE live mix
//
// The third is deliberately not the second. A tag filter unmounts a card, but
// audioCoordinator owns the <audio>, and element lifetime follows LANE
// membership, not visibility: a clip hidden by a filter keeps playing on the
// clock, so re-checking that filter shows a card at the position the clip
// actually reached rather than one restarting from zero. What the filter does
// change is the MIX — a hidden card is not audible, and a solo pointing at one
// is reconciled away, because effectiveMutedIds mutes everything except the
// solo target and an absent target means silence with nothing left on screen to
// click.

import {
	ClassicyApp,
	ClassicyIcons,
	ClassicyWindow,
	intToHex,
	quitMenuItemHelper,
	registerClassicyIcons,
	useAppManager,
	useAppManagerDispatch,
	useClassicyDateTime,
} from "classicy";
import type React from "react";
import {
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useAboutApp } from "../../Components/AboutApp/AboutApp";
import { manifestDescription } from "../../Components/manifestDescription";
import {
	MediaStreamContext,
	type MediaItem,
} from "../../Providers/MediaStream/MediaStreamContext";
import { virtualUtcMs } from "../../Providers/MediaStream/virtualClock";
import { isAudioBlocked, subscribeAudioBlocked } from "../radio-core/audioBlocked";
import { resolveAudioUrl } from "../radio-core/audioSource";
import { BROADCAST_STATIONS, groupStations, startMs } from "../radio-core/stationGrouping";
import appIconPng from "./app.png";
import { connectClock, clockMoved, ensure, release, releaseAll, setLevel } from "./audioCoordinator";
import { historyPool, type Lane, laneFor, rememberItems } from "./cardStatus";
import { FilterTree } from "./FilterTree";
import { LANES, type LaneOrder, reconcileLaneOrder, reorderLane } from "./laneOrder";
import { LaneSection } from "./LaneSection";
import { LaneSmallPlayer } from "./LaneSmallPlayer";
import { nextHeldLiveIds, sameIdSet, withAudibleHold } from "./liveHold";
import styles from "./radioTraffic.module.scss";
import {
	radioTrafficSetState,
	type RadioTrafficSettings,
	sanitizeRadioTrafficState,
} from "./RadioTrafficContext";
import { RadioTrafficSettingsWindow } from "./RadioTrafficSettingsWindow";
import { groupVocabulary, matchesFilter } from "./tagFilter";
import { TagPickerWindow } from "./TagPickerWindow";
import { reconcileTagVocabulary, type VocabularyState } from "./tagVocabulary";
import {
	applyToolClick,
	type AudioState,
	isAudible,
	reconcileSolo,
	releaseLaneMute,
	type Tool,
} from "./toolMode";
import { ToolPalette } from "./ToolPalette";
import { TrafficCard } from "./TrafficCard";

const appId = "RadioTraffic.app";
const appName = "Radio Traffic";

/**
 * How many cards the two scrolling lanes show.
 *
 * The back catalogue is ~755 items and every one of them is PREVIOUS by the end
 * of a session; the grid is designed for roughly ten cards on screen (see the
 * plan's Performance Considerations), and a lane rendering all 755 would mount
 * 755 canvases for waveforms nobody has scrolled to. Newest-first ordering makes
 * the cap the right ten: the clip that just ended is the one a listener reaches
 * for.
 */
const UPCOMING_LANE_LIMIT = 12;
const PREVIOUS_LANE_LIMIT = 12;

// This app's own icon, registered into the shared registry at
// ClassicyIcons.applications.radioTraffic.app. registerClassicyIcons assigns
// shallowly, so the existing applications namespace is spread in to keep
// classicy's bundled app icons intact (same gotcha as FlightTracker.tsx).
const ICONS = registerClassicyIcons({
	applications: {
		...ClassicyIcons.applications,
		radioTraffic: { app: appIconPng },
	},
});

const byStartAscending = (a: MediaItem, b: MediaItem) =>
	startMs(a) - startMs(b) || a.id - b.id;

/**
 * One catalogue, keyed by id with the LAST copy winning.
 *
 * The three sources overlap and disagree: `mp3_history` is a snapshot, the live
 * `mp3` set is fresher (a row can gain an `end_date` after the snapshot), and
 * the reveal buffer holds rows that have not started yet. Caller order is
 * therefore load bearing — history first, live over it.
 */
function mergeById(...lists: readonly (readonly MediaItem[])[]): MediaItem[] {
	const byId = new Map<number, MediaItem>();
	for (const list of lists) for (const item of list) byId.set(item.id, item);
	return [...byId.values()];
}

/**
 * Everything that is comm traffic — i.e. everything the Radio Tuner does not own.
 *
 * The mp3 stream carries both kinds of audio, and BROADCAST_STATIONS is the one
 * set that splits them: the Tuner filters TO it (RadioTuner.tsx), the Scanner
 * filters AWAY from it (RadioScanner.tsx), and this app was doing neither — so
 * WCBS, WINS, WABC and the rest of the fourteen continuous broadcasters were
 * arriving as traffic cards. This is the Scanner's `!BROADCAST_STATIONS.has(key)`
 * test, unchanged.
 *
 * Station membership is asked via groupStations because the source→key rule
 * (`source`, falling back to `title`) is stationGrouping's and is not exported
 * on its own. Reimplementing it here would be a second answer free to disagree
 * with the ten consumers that already share the first; cardStatus.laneFor takes
 * the same one-item-station route for the same reason. The regrouping reorders
 * the pool, which is harmless — partitionLanes sorts every lane afterwards.
 */
function excludeBroadcastStations(pool: readonly MediaItem[]): MediaItem[] {
	return groupStations([...pool])
		.filter((station) => !BROADCAST_STATIONS.has(station.key))
		.flatMap((station) => station.items);
}

/**
 * Every card, in its lane, in the order that lane renders before manual pins.
 *
 * `heldLiveIds` is Story 045's audible hold (see liveHold.ts): an id in it
 * overrides an otherwise-PREVIOUS verdict back to LIVE, so a player the
 * listener can still hear does not vanish out from under them the instant its
 * clock window ends. `laneFor` itself stays exactly as clock-only as its own
 * header promises — this is the reconciliation, not a rewrite of the rule.
 */
function partitionLanes(
	pool: readonly MediaItem[],
	nowMs: number,
	heldLiveIds: ReadonlySet<number>,
): Record<Lane, MediaItem[]> {
	const out: Record<Lane, MediaItem[]> = { live: [], upcoming: [], previous: [] };
	for (const item of pool) {
		out[withAudibleHold(laneFor(item, nowMs), item.id, heldLiveIds)].push(item);
	}
	out.live.sort(byStartAscending);
	out.upcoming.sort(byStartAscending);
	out.previous.sort((a, b) => byStartAscending(b, a));
	return {
		live: out.live,
		upcoming: out.upcoming.slice(0, UPCOMING_LANE_LIMIT),
		previous: out.previous.slice(0, PREVIOUS_LANE_LIMIT),
	};
}

/**
 * `set` with `id` added or removed, or `set` itself when nothing moved — these
 * feed React state directly, and a fresh Set per no-op click would re-render the
 * whole grid for nothing.
 */
function toggleId(set: ReadonlySet<number>, id: number): ReadonlySet<number> {
	const next = new Set(set);
	if (!next.delete(id)) next.add(id);
	return next;
}

/** `set` minus everything `keep` rejects; the same object when nothing was dropped. */
function retainIds(
	set: ReadonlySet<number>,
	keep: (id: number) => boolean,
): ReadonlySet<number> {
	const next = new Set([...set].filter(keep));
	return next.size === set.size ? set : next;
}

export const RadioTraffic: React.FC = () => {
	const appIcon = ICONS.applications.radioTraffic.app as string;
	const aboutWindow = useAboutApp(appId, appIcon);

	const dispatch = useAppManagerDispatch();
	const appState = useAppManager(
		(state) =>
			state.System.Manager.Applications.apps[appId]?.data as
				| Record<string, unknown>
				| undefined,
	);

	// Persisted state is read ONCE, through the sanitizer, and owned as React
	// state from there on. Re-reading it would fight the dispatch below, which
	// writes the same keys back on every change.
	const [restored] = useState(() => sanitizeRadioTrafficState(appState));
	const [checked, setChecked] = useState<ReadonlySet<string>>(
		() => new Set(restored.checked),
	);
	const [tool, setTool] = useState<Tool>(restored.tool);
	const [collapsed, setCollapsed] = useState<Record<Lane, boolean>>(restored.collapsed);
	const [laneOrder, setLaneOrder] = useState<LaneOrder>(restored.laneOrder);
	// Solo is not restored — see RadioTrafficContext's mutedItems note.
	const [audio, setAudio] = useState<AudioState>(() => ({
		soloId: null,
		muted: new Set(restored.mutedItems),
	}));
	/**
	 * The LIVE lane silenced as a whole (story 040).
	 *
	 * Held apart from `audio.muted` rather than folded into it because it is a
	 * different KIND of instruction: the per-card set names clips, and this names
	 * the lane, so it keeps silencing whatever the clock brings in next. Folding
	 * it in at mute time would go quiet and then start talking again a minute
	 * later, which is precisely the complaint the story is about.
	 */
	const [liveLaneMuted, setLiveLaneMuted] = useState(restored.liveLaneMuted);
	const [settings, setSettings] = useState<RadioTrafficSettings>(() => ({
		useThemeWaveformColor: restored.useThemeWaveformColor,
		waveformColor: restored.waveformColor,
		playOriginalAudio: restored.playOriginalAudio,
	}));

	// The Settings draft (the Tuner's pattern, and TimeMachine's before it):
	// seeded from the live setting when the window opens and dispatched only on
	// Save, so Cancel — and the window's close box, which is Cancel — leaves
	// nothing behind. `showSettings` is ephemeral and deliberately not persisted.
	const [showSettings, setShowSettings] = useState(false);
	const [settingsForm, setSettingsForm] = useState<RadioTrafficSettings>(settings);
	const openSettings = useCallback(() => {
		setSettingsForm(settings);
		setShowSettings(true);
	}, [settings]);
	const saveSettingsForm = useCallback(() => {
		setSettings(settingsForm);
		setShowSettings(false);
	}, [settingsForm]);

	// undefined = follow the theme, which is what `.rtCardWaveform`'s
	// --color-system-06 already does; the card only overrides `color` when the
	// listener has actually chosen one.
	const waveformColor = settings.useThemeWaveformColor
		? undefined
		: intToHex(settings.waveformColor);

	const [pickerNamespace, setPickerNamespace] = useState<string | null>(null);
	/** LIVE cards the listener stopped by hand. */
	const [stopped, setStopped] = useState<ReadonlySet<number>>(() => new Set());
	/** PREVIOUS clips the listener started by hand — these do NOT follow the clock. */
	const [userStarted, setUserStarted] = useState<ReadonlySet<number>>(() => new Set());
	/**
	 * Story 045: LIVE ids `partitionLanes` holds past their clock window because
	 * the listener can still hear them — see liveHold.ts. Read one render behind
	 * on purpose: it names ids that were already in `lanes.live`, so it can only
	 * ever widen LIVE with something that was already there, never manufacture a
	 * membership `laneFor` never granted.
	 */
	const [heldLiveIds, setHeldLiveIds] = useState<ReadonlySet<number>>(() => new Set());

	const {
		mp3Items,
		mp3History,
		mp3Meta,
		mp3MetaGeneration,
		seekInFlight,
		subscribeMp3,
		unsubscribeMp3,
		getUpcomingMp3Items,
	} = useContext(MediaStreamContext);

	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally mount-only
	useEffect(() => {
		subscribeMp3(appId);
		return () => unsubscribeMp3(appId);
	}, [subscribeMp3, unsubscribeMp3]);

	// ── The clock ────────────────────────────────────────────────────────────
	// Read-only: every clock WRITE in this repo goes through
	// TimeMachine/setVirtualClock, and this app is a reader. `localDate` is a
	// DISPLAY value (UTC shifted by tzOffset for the menu-bar clock) and
	// virtualUtcMs strips the offset back off — comparing it directly against an
	// item's start_date is the tz bug virtualClock.test.ts pins.
	const { localDate, tzOffset, paused: clockPaused } = useClassicyDateTime({ tick: true });
	const tz = Number(tzOffset);
	const anchorMs = virtualUtcMs(localDate, tz);

	// Sub-minute correction, ported from RadioScanner/StationPlayer: the store
	// only updates on minute boundaries and the hook's tick republishes once a
	// second, so between publications the last known instant plus the REAL time
	// elapsed since it was stamped is the honest answer — and a paused clock
	// contributes no elapsed time at all. calcSeekSeconds (radio-core,
	// unchanged) turns that instant into an element position.
	//
	// The stamp is taken during render rather than in an effect: an effect runs
	// after this render has already called getNowMs(), so the first read after
	// every tick would add the *previous* second's elapsed time on top of the
	// new anchor and report the clock up to a second ahead of itself — inside
	// the badge's 1s in-sync tolerance, which is exactly where it would show.
	const anchorRef = useRef(anchorMs);
	const anchorAtRef = useRef(Date.now());
	if (anchorRef.current !== anchorMs) {
		anchorRef.current = anchorMs;
		anchorAtRef.current = Date.now();
	}
	const clockPausedRef = useRef(clockPaused);
	clockPausedRef.current = clockPaused;

	const getNowMs = useCallback(() => {
		const elapsed = clockPausedRef.current ? 0 : Date.now() - anchorAtRef.current;
		return anchorRef.current + elapsed;
	}, []);
	const nowMs = getNowMs();

	// ── The catalogue ────────────────────────────────────────────────────────
	// Everything ever seen live, so a clip that ends BETWEEN two history
	// snapshots still lands in PREVIOUS instead of disappearing (see
	// rememberItems). This map is also the coordinator's item source, so the
	// audio and the cards can never disagree about what an item is.
	const seenRef = useRef<Map<number, MediaItem>>(new Map());
	useEffect(() => {
		rememberItems(seenRef.current, mp3Items);
	}, [mp3Items]);

	// The reveal buffer is mutable and not React state; re-read it once a second.
	// biome-ignore lint/correctness/useExhaustiveDependencies: anchorMs is the 1 Hz clock dep
	const upcomingItems = useMemo(
		() => getUpcomingMp3Items(),
		[anchorMs, getUpcomingMp3Items], // eslint-disable-line react-hooks/exhaustive-deps
	);

	// anchorMs, not nowMs: lane membership is a once-a-second question, and
	// keying it on the ms-precise reading would repartition the whole catalogue
	// on every render for an answer that cannot have changed.
	// biome-ignore lint/correctness/useExhaustiveDependencies: anchorMs is the 1 Hz clock dep
	const lanes = useMemo(
		() =>
			partitionLanes(
				excludeBroadcastStations(
					mergeById(historyPool(mp3History, seenRef.current), mp3Items, upcomingItems),
				),
				getNowMs(),
				heldLiveIds,
			),
		[mp3History, mp3Items, upcomingItems, anchorMs, getNowMs, heldLiveIds], // eslint-disable-line react-hooks/exhaustive-deps
	);

	// Story 045: what to hold NEXT render, derived from what LIVE actually holds
	// THIS render — see liveHold.ts's header for why the memory lives out here
	// rather than in that module. `stopped` and lane/per-card mute are read
	// straight off React state rather than through the `visible.live`/isAudible
	// pipeline built below, because a filter-hidden card is still part of the
	// mix (the same rule the audio-registration effect follows) and must not
	// lose its hold just because a tag filter hid it.
	//
	// biome-ignore lint/correctness/useExhaustiveDependencies: sameIdSet keeps this from looping — see the setHeldLiveIds call
	useEffect(() => {
		const isHeldAudible = (itemId: number) =>
			!liveLaneMuted && !stopped.has(itemId) && isAudible(audio, itemId, "live");
		setHeldLiveIds((prev) => {
			const next = nextHeldLiveIds(lanes.live, isHeldAudible);
			return sameIdSet(prev, next) ? prev : next;
		});
	}, [lanes.live, audio, liveLaneMuted, stopped]); // eslint-disable-line react-hooks/exhaustive-deps

	/** Which lane each rendered card is in — the pin reconciler's whole input. */
	const membership = useMemo(() => {
		const map = new Map<number, Lane>();
		for (const lane of LANES) for (const item of lanes[lane]) map.set(item.id, lane);
		return map;
	}, [lanes]);
	const membershipRef = useRef(membership);
	membershipRef.current = membership;

	// A pin means "this slot among these siblings", and the siblings are the
	// lane — so a pin dies when its item changes lane, and with it the map's
	// unbounded growth over a long session of seeks.
	useEffect(() => {
		setLaneOrder((order) => reconcileLaneOrder(order, membership));
	}, [membership]);

	// Both hand-set lists are scoped to a lane the item may have left. Pruning
	// them here is what stops a stop/start from a previous hour reapplying
	// itself when a backward seek brings the clip round again.
	useEffect(() => {
		setStopped((ids) => retainIds(ids, (id) => membership.get(id) === "live"));
		setUserStarted((ids) => retainIds(ids, (id) => membership.has(id)));
	}, [membership]);

	// ── The filter ───────────────────────────────────────────────────────────
	const [vocabulary, setVocabulary] = useState<VocabularyState>(() => ({
		vocabulary: [],
		generation: null,
		stale: false,
	}));
	useEffect(() => {
		let alive = true;
		// Never rejects — a failure resolves to the last-known-good copy flagged
		// stale, because tag filtering IS this app's navigation (Decision 5).
		reconcileTagVocabulary(mp3MetaGeneration).then((next) => {
			if (alive) setVocabulary(next);
		});
		return () => {
			alive = false;
		};
	}, [mp3MetaGeneration]);

	const groups = useMemo(() => groupVocabulary(vocabulary.vocabulary), [vocabulary]);

	const visible = useMemo(() => {
		const keep = (item: MediaItem) => matchesFilter(mp3Meta[item.id]?.tags, checked);
		return {
			live: lanes.live.filter(keep),
			upcoming: lanes.upcoming.filter(keep),
			previous: lanes.previous.filter(keep),
		};
	}, [lanes, mp3Meta, checked]);

	// ── Audio ────────────────────────────────────────────────────────────────
	// The mix is the FILTER-VISIBLE live cards, so hiding the solo target hands
	// the solo on rather than silencing the grid. Called on every visible-mix
	// change; reconcileSolo returns the same object when the target is still
	// there, so React bails out of the no-op renders.
	useEffect(() => {
		setAudio((state) => reconcileSolo(state, visible.live));
	}, [visible.live]);

	const userStartedRef = useRef(userStarted);
	userStartedRef.current = userStarted;

	// The coordinator's view of this app, installed once. `itemFor` reads the
	// same map rememberItems maintains — one source of item truth — and returns
	// undefined for a listener-started clip, which is how such a clip opts out of
	// the reseek, the health check and the gesture retry: it plays from its own
	// start, not from the virtual clock's position.
	useEffect(
		() =>
			connectClock({
				nowMs: getNowMs,
				clockPaused: () => clockPausedRef.current,
				itemFor: (itemId) =>
					userStartedRef.current.has(itemId) ? undefined : seenRef.current.get(itemId),
			}),
		[getNowMs],
	);

	// A jump larger than the coordinator's threshold is a scrub and reseeks every
	// registered element, mounted or not; ordinary per-second advance is ignored.
	useEffect(() => {
		clockMoved();
	}, [anchorMs]);

	// Which elements should exist, and WHICH COPY of each recording they play.
	// LANE membership, NOT filter visibility: the element outlives the card so a
	// re-checked filter resumes at the clock's offset instead of restarting.
	// Tracked here because the registry is module-level and release() is an
	// explicit act, never a render side effect.
	//
	// resolveAudioUrl, never `item.url`: the mp3 rows carry both the source
	// recording and the noise-reduced render, and which one a listener hears is
	// the "Play original recording" setting. Re-running on that setting is the
	// whole of switching copies mid-session — `ensure` re-points the SAME element
	// at the new src (audioCapture's graph is bound to the element for life, so
	// tearing it down would silently orphan every card's waveform), which is why
	// the swap needs no reload and costs no playback position the coordinator's
	// clock reseek does not immediately restore.
	const registeredRef = useRef<Set<number>>(new Set());
	useEffect(() => {
		const desired = new Map<number, string>();
		for (const item of lanes.live) {
			if (!stopped.has(item.id))
				desired.set(item.id, resolveAudioUrl(item, settings.playOriginalAudio));
		}
		for (const item of lanes.previous) {
			if (userStarted.has(item.id))
				desired.set(item.id, resolveAudioUrl(item, settings.playOriginalAudio));
		}
		for (const itemId of [...registeredRef.current]) {
			if (desired.has(itemId)) continue;
			release(itemId);
			registeredRef.current.delete(itemId);
		}
		for (const [itemId, url] of desired) {
			ensure(itemId, url);
			registeredRef.current.add(itemId);
		}
	}, [lanes.live, lanes.previous, stopped, userStarted, settings.playOriginalAudio]);

	// The app unmounting is the one moment nothing else can stop the sound:
	// these elements are never in the DOM, so a dropped registry is a leak that
	// keeps playing.
	useEffect(
		() => () => {
			releaseAll();
			registeredRef.current.clear();
		},
		[],
	);

	// Silence, not pause: a paused element stops advancing and drifts off the
	// clock, so unmuting it later would drop the listener into a stale offset.
	useEffect(() => {
		// A muted lane is silent outright, whatever the per-card mix says — which
		// is what makes the flag cover clips that arrive after the button was
		// pressed, since they are simply never added to this set.
		const audibleIds = new Set(
			liveLaneMuted
				? []
				: visible.live.filter((item) => isAudible(audio, item.id, "live")).map((i) => i.id),
		);
		for (const itemId of registeredRef.current) {
			// A clip the listener started themselves is audible by definition —
			// they pressed play, and it is not part of the solo/mute mix at all.
			setLevel(itemId, audibleIds.has(itemId) || userStarted.has(itemId));
		}
	}, [visible.live, audio, userStarted, liveLaneMuted]);

	const audioBlocked = useSyncExternalStore(subscribeAudioBlocked, isAudioBlocked);

	// ── Persistence ──────────────────────────────────────────────────────────
	useEffect(() => {
		dispatch(
			radioTrafficSetState({
				checked: [...checked],
				tool,
				collapsed,
				laneOrder,
				mutedItems: [...audio.muted],
				liveLaneMuted,
				useThemeWaveformColor: settings.useThemeWaveformColor,
				waveformColor: settings.waveformColor,
				playOriginalAudio: settings.playOriginalAudio,
			}),
		);
	}, [
		checked,
		tool,
		collapsed,
		laneOrder,
		audio.muted,
		liveLaneMuted,
		settings,
		dispatch,
	]);

	// ── Handlers ─────────────────────────────────────────────────────────────
	const toggleTag = useCallback((tag: string) => {
		setChecked((prev) => {
			const next = new Set(prev);
			if (!next.delete(tag)) next.add(tag);
			return next;
		});
	}, []);

	const onCardClick = useCallback(
		(itemId: number, lane: Lane) => {
			// Clicking a live card while the lane is muted is the listener naming
			// the one clip they want back, so the lane flag hands over to per-card
			// mutes on everything else and clears. It comes BEFORE the tool because
			// it is not a tool action: whichever tool is up, the click a listener
			// makes on a silenced lane means "let me hear this one".
			if (liveLaneMuted && lane === "live") {
				setLiveLaneMuted(false);
				setAudio((state) => releaseLaneMute(state, lanes.live, itemId));
				return;
			}
			setAudio((state) => applyToolClick(state, tool, itemId));
		},
		[liveLaneMuted, lanes.live, tool],
	);

	const onTogglePause = useCallback((itemId: number, lane: Lane) => {
		if (lane === "live") setStopped((ids) => toggleId(ids, itemId));
		// An UPCOMING clip has no audio yet; there is nothing to start.
		else if (lane === "previous") setUserStarted((ids) => toggleId(ids, itemId));
	}, []);

	const onReorder = useCallback(
		(lane: Lane, fromId: number, toIndex: number) =>
			setLaneOrder((order) =>
				reorderLane(order, lane, fromId, toIndex, membershipRef.current),
			),
		[],
	);

	const renderCard = useCallback(
		(lane: Lane) => (item: MediaItem) => (
			// A plain div with a pointer handler, exactly like the lane slot it
			// sits in: making it focusable would put a tab stop in front of every
			// card's own tab bar and transport button. Under the `hand` tool the
			// slot's drag handlers run too, and applyToolClick("hand") is a no-op,
			// so a drag cannot also mute something.
			<div
				className={styles.rtCardSlot}
				data-card-slot={item.id}
				onPointerUp={() => onCardClick(item.id, lane)}
			>
				<TrafficCard
					item={item}
					meta={mp3Meta[item.id]}
					lane={lane}
					tzOffsetHours={tz}
					nowMs={nowMs}
					seeking={seekInFlight}
					userPlaying={userStarted.has(item.id)}
					// A muted lane overrides the per-card mix outright, so the
					// speaker on every live card shows the silence the listener can
					// actually hear rather than the mix underneath it.
					muted={
						(lane === "live" && liveLaneMuted) ||
						(!isAudible(audio, item.id, lane) && !userStarted.has(item.id))
					}
					paused={
						lane === "live" ? stopped.has(item.id) : !userStarted.has(item.id)
					}
					onTogglePause={() => onTogglePause(item.id, lane)}
					waveformColor={waveformColor}
				/>
			</div>
		),
		[
			mp3Meta,
			tz,
			nowMs,
			seekInFlight,
			userStarted,
			audio,
			liveLaneMuted,
			stopped,
			onCardClick,
			onTogglePause,
			waveformColor,
		],
	);

	// The folded lanes' players (story 027). One renderer for all three lanes,
	// because a small player carries no lane-dependent state — no badge, no
	// transport, no mute — which is exactly what makes it small.
	const renderCollapsedCard = useCallback(
		(item: MediaItem) => (
			<LaneSmallPlayer item={item} meta={mp3Meta[item.id]} tzOffsetHours={tz} />
		),
		[mp3Meta, tz],
	);

	const appMenu = [
		{
			id: "file",
			title: "File",
			menuChildren: [
				{ id: "settings", title: "Settings…", onClickFunc: openSettings },
				quitMenuItemHelper(appId, appName, appIcon),
			],
		},
	];

	const pickerGroup = groups.find((group) => group.namespace === pickerNamespace);

	return (
		<ClassicyApp
			id={appId}
			name={appName}
			icon={appIcon}
			defaultWindow={`${appId}_main`}
			desktopIconBalloonHelp={manifestDescription(appId)}
		>
			{showSettings && (
				<RadioTrafficSettingsWindow
					appId={appId}
					appIcon={appIcon}
					appMenu={appMenu}
					form={settingsForm}
					setForm={setSettingsForm}
					onCancel={() => setShowSettings(false)}
					onSave={saveSettingsForm}
				/>
			)}
			{pickerGroup && (
				<TagPickerWindow
					appId={appId}
					icon={appIcon}
					namespace={pickerGroup.namespace}
					label={pickerGroup.label}
					values={pickerGroup.values}
					checked={checked}
					// The picker is handed the WHOLE checked set and hands back the
					// whole set, so there is no merge here to get wrong.
					onConfirm={(next) => {
						setChecked(next);
						setPickerNamespace(null);
					}}
					onCancel={() => setPickerNamespace(null)}
				/>
			)}
			<ClassicyWindow
				id={`${appId}_main`}
				title={appName}
				appId={appId}
				icon={appIcon}
				closable={true}
				resizable={true}
				zoomable={true}
				scrollable={false}
				collapsable={true}
				initialSize={[892, 601]}
				initialPosition={["left", "top"]}
				minimumSize={[520, 320]}
				modal={false}
				appMenu={appMenu}
			>
				<div className={styles.rtShell}>
					{audioBlocked && (
						<div className={styles.rtUnlockOverlay}>
							<div className={styles.rtUnlockOverlayBox}>
								<p className={styles.rtUnlockOverlayTitle}>
									Click anywhere to start audio
								</p>
								<p className={styles.rtUnlockOverlayHint}>
									Your browser paused sound until you interact with the page
								</p>
							</div>
						</div>
					)}
					<aside className={styles.rtSidebar}>
						<ToolPalette tool={tool} onSelect={setTool} />
						<FilterTree
							groups={groups}
							checked={checked}
							onToggle={toggleTag}
							onOpenPicker={setPickerNamespace}
							stale={vocabulary.stale}
						/>
					</aside>
					<main className={styles.rtLanes}>
						{LANES.map((lane) => (
							<LaneSection
								key={lane}
								lane={lane}
								items={visible[lane]}
								order={laneOrder[lane]}
								// Story 044: the one card that must not appear to move when
								// the lane reflows. LIVE's active card is whichever one is
								// soloed (or, with no solo, still the mix — soloId is the
								// only single-card signal LIVE has); PREVIOUS has no solo
								// concept, so it's the most recently hand-started clip.
								activeId={
									lane === "live"
										? audio.soloId
										: lane === "previous"
											? ([...userStarted].at(-1) ?? null)
											: null
								}
								collapsed={collapsed[lane]}
								onToggleCollapse={(next) =>
									setCollapsed((prev) => ({ ...prev, [lane]: next }))
								}
								// LIVE alone gets the mute-all control, because LIVE alone
								// has a mix: UPCOMING has no audio yet, and PREVIOUS plays
								// only the clips the listener started by hand, which are not
								// part of the solo/mute model at all.
								muted={lane === "live" && liveLaneMuted}
								onToggleMute={lane === "live" ? setLiveLaneMuted : undefined}
								tool={tool}
								onReorder={(fromId, toIndex) => onReorder(lane, fromId, toIndex)}
								renderCard={renderCard(lane)}
								renderCollapsedCard={renderCollapsedCard}
							/>
						))}
					</main>
				</div>
			</ClassicyWindow>
			{aboutWindow}
		</ClassicyApp>
	);
};
