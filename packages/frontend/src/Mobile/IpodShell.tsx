// packages/frontend/src/Mobile/IpodShell.tsx
// The mobile branch: iPod chrome + screen stack. The shell owns the wheel
// (MENU pops, play/pause toggles the virtual clock — StationPlayer already
// pauses audio when the clock pauses), the active now-playing source (radio
// station or TV channel), and the mp3 subscription; screens own their list
// state and register scroll/select meaning via useScreenWheel.
import { useAppManager, useClassicyDateTime } from "classicy";
import {
	useCallback,
	useEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
} from "react";
import { DEFAULT_RADIO_SCANNER_SETTINGS } from "../Applications/RadioScanner/radioScannerSettings";
import { StationPlayer } from "../Applications/RadioScanner/StationPlayer";
import { mergeWithSources } from "../Applications/RadioScanner/stationGrouping";
import { formatUtcAsLocalTime } from "../Applications/TimeMachine/setVirtualClock";
import type { MediaStreamFilter } from "../Providers/MediaStream/MediaStreamContext";
import { useMediaStream } from "../Providers/MediaStream/useMediaStream";
import { IpodChrome } from "./IpodChrome";
import {
	currentScreen,
	initialScreenStack,
	SCREEN_TITLES,
	screenStackReducer,
	type ScreenId,
} from "./screenStack";
import { TvPlayer } from "./TvPlayer";
import { useClickWheel } from "./useClickWheel";
import { useFineClock } from "./useFineClock";
import {
	ScreenNavContext,
	WheelContext,
	type ScreenWheelHandlers,
} from "./WheelContext";
import { AboutScreen } from "./screens/AboutScreen";
import { BookmarksScreen } from "./screens/BookmarksScreen";
import { MainMenu } from "./screens/MainMenu";
import { NowPlayingScreen } from "./screens/NowPlayingScreen";
import { RadioScreen } from "./screens/RadioScreen";
import { ScrubScreen } from "./screens/ScrubScreen";
import { TimeTravelScreen } from "./screens/TimeTravelScreen";
import { TVScreen } from "./screens/TVScreen";

const APP_ID = "IpodShell.mobile";

// Same filter as the desktop TV app: every approved HLS channel. Hoisted so
// its reference is stable — useMediaStream memoizes the filtered list on it.
const TV_CHANNELS_FILTER: MediaStreamFilter = { format: ["m3u8"], approved: true };

/** The single "now playing" source — tuning either kind evicts the other,
 *  which is the whole one-at-a-time rule (design decision 2026-07-15). */
export type NowPlayingSource =
	| { kind: "radio"; key: string }
	| { kind: "tv"; id: number };

// The mobile shell never shows the waveform (showWaveform is always false),
// so StationPlayer's viz props are inert here — defaults and a stable no-op.
const noopCycleVizMode = () => {};

export default function IpodShell() {
	const [stackState, dispatchStack] = useReducer(screenStackReducer, initialScreenStack);
	const screen = currentScreen(stackState);
	const { nowMs, getNowMs, clockPaused, tzOffset } = useFineClock();
	const { paused, pause, resume } = useClassicyDateTime();
	// While the server forces the clock, nothing on this shell may move it:
	// Time Travel/Bookmarks/Scrub get evicted and the wheel's play/pause is inert.
	const dateTimeLocked = useAppManager(
		(s) => s.System.Manager.DateAndTime.dateTimeLocked,
	);
	const {
		connected,
		mp3Items,
		sources,
		subscribeMp3,
		unsubscribeMp3,
		items: tvChannels,
	} = useMediaStream(TV_CHANNELS_FILTER);

	// biome-ignore lint/correctness/useExhaustiveDependencies: mount-only subscription
	useEffect(() => {
		subscribeMp3(APP_ID);
		return () => unsubscribeMp3(APP_ID);
	}, [subscribeMp3, unsubscribeMp3]);

	const [nowPlaying, setNowPlaying] = useState<NowPlayingSource | null>(null);
	const stations = useMemo(
		() => mergeWithSources(sources.audio, mp3Items),
		[sources.audio, mp3Items],
	);
	const activeStation =
		nowPlaying?.kind === "radio"
			? (stations.find((s) => s.key === nowPlaying.key) ?? null)
			: null;
	const activeTvItem =
		nowPlaying?.kind === "tv"
			? (tvChannels.find((i) => i.id === nowPlaying.id) ?? null)
			: null;

	// The active screen's wheel meaning; shell-level MENU / play-pause always work.
	const screenHandlersRef = useRef<ScreenWheelHandlers>({});
	const wheelRegistry = useMemo(
		() => ({
			register: (h: ScreenWheelHandlers) => {
				screenHandlersRef.current = h;
				return () => {
					if (screenHandlersRef.current === h) screenHandlersRef.current = {};
				};
			},
		}),
		[],
	);

	const nav = useMemo(
		() => ({
			push: (id: ScreenId) => dispatchStack({ type: "push", id }),
			pop: () => dispatchStack({ type: "pop" }),
		}),
		[],
	);

	const tuneStation = useCallback((key: string) => {
		setNowPlaying({ kind: "radio", key });
	}, []);

	const tuneTvChannel = useCallback((id: number) => {
		setNowPlaying({ kind: "tv", id });
	}, []);

	// Forced clock: kick the user off any screen that can move the clock. The
	// stack only ever nests these three as menu → timeTravel → bookmarks|scrub,
	// so one pop per re-render (screen is a dependency) walks all the way back.
	useEffect(() => {
		if (!dateTimeLocked) return;
		if (screen === "timeTravel" || screen === "bookmarks" || screen === "scrub") {
			dispatchStack({ type: "pop" });
		}
	}, [dateTimeLocked, screen]);

	const wheel = useClickWheel({
		onScroll: (steps) => screenHandlersRef.current.onScroll?.(steps),
		onSelect: () => screenHandlersRef.current.onSelect?.(),
		onPrev: () => screenHandlersRef.current.onPrev?.(),
		onNext: () => screenHandlersRef.current.onNext?.(),
		onMenu: () => dispatchStack({ type: "pop" }),
		onPlayPause: () => {
			if (dateTimeLocked) return;
			if (paused) resume();
			else pause();
		},
	});

	const clockLabel = formatUtcAsLocalTime(
		new Date(nowMs).toISOString(),
		tzOffset,
	).replace(/:\d\d /, " "); // h:mm AM (drop seconds for the status bar)

	return (
		<div className="ipodRoot">
			<WheelContext.Provider value={wheelRegistry}>
				<ScreenNavContext.Provider value={nav}>
					<IpodChrome wheel={wheel}>
						<div className="ipodHeader">
							<span className="ipodHeaderTitle">{SCREEN_TITLES[screen]}</span>
							<span className="ipodHeaderClock">
								{nowPlaying && (
									<span className={paused ? "ipodHeaderPause" : "ipodHeaderPlay"} />
								)}
								{clockLabel}
							</span>
						</div>
						{/* The menu, About, and Time Travel all work without the stream —
						    only data screens gate on the connection (RadioScreen shows
						    its own Connecting… state). */}
						{activeTvItem && (
							<TvPlayer
								key={activeTvItem.id}
								item={activeTvItem}
								visible={screen === "nowPlaying"}
								nowMs={nowMs}
								getNowMs={getNowMs}
								clockPaused={clockPaused}
							/>
						)}
						<div className="ipodScreenBody" key={screen}>
							{screen === "menu" && (
								<MainMenu hasNowPlaying={nowPlaying !== null} />
							)}
							{screen === "about" && <AboutScreen />}
							{screen === "radio" && (
								<RadioScreen
									stations={stations}
									nowMs={nowMs}
									activeStationKey={
										nowPlaying?.kind === "radio" ? nowPlaying.key : ""
									}
									onTune={tuneStation}
									connected={connected}
								/>
							)}
							{screen === "tv" && (
								<TVScreen
									channels={tvChannels}
									activeTvId={nowPlaying?.kind === "tv" ? nowPlaying.id : null}
									onTune={tuneTvChannel}
									connected={connected}
								/>
							)}
							{screen === "nowPlaying" && (
								<NowPlayingScreen
									station={activeStation}
									tvChannel={activeTvItem}
									nowMs={nowMs}
									tzOffset={tzOffset}
									clockPaused={clockPaused}
								/>
							)}
							{screen === "timeTravel" && <TimeTravelScreen />}
							{screen === "bookmarks" && <BookmarksScreen tzOffset={tzOffset} />}
							{screen === "scrub" && (
								<ScrubScreen getNowMs={getNowMs} tzOffset={tzOffset} />
							)}
						</div>
					</IpodChrome>
					{activeStation && (
						<StationPlayer
							station={activeStation}
							nowMs={nowMs}
							getNowMs={getNowMs}
							stationMuted={false}
							mutedItems={[]}
							clockPaused={clockPaused}
							showWaveform={false}
							vizMode={DEFAULT_RADIO_SCANNER_SETTINGS.vizMode}
							onCycleVizMode={noopCycleVizMode}
							waveColors={null}
							maxVolume={DEFAULT_RADIO_SCANNER_SETTINGS.maxVolume / 100}
						/>
					)}
				</ScreenNavContext.Provider>
			</WheelContext.Provider>
		</div>
	);
}
