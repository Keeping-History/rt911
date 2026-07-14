// packages/frontend/src/Mobile/IpodShell.tsx
// The mobile branch: iPod chrome + screen stack. The shell owns the wheel
// (MENU pops, play/pause toggles the virtual clock — StationPlayer already
// pauses audio when the clock pauses), the active station, and the mp3
// subscription; screens own their list state and register scroll/select
// meaning via useScreenWheel.
import { useClassicyDateTime } from "classicy";
import {
	useCallback,
	useContext,
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
import { MediaStreamContext } from "../Providers/MediaStream/MediaStreamContext";
import { IpodChrome } from "./IpodChrome";
import {
	currentScreen,
	initialScreenStack,
	SCREEN_TITLES,
	screenStackReducer,
	type ScreenId,
} from "./screenStack";
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

const APP_ID = "IpodShell.mobile";

// The mobile shell never shows the waveform (showWaveform is always false),
// so StationPlayer's viz props are inert here — defaults and a stable no-op.
const noopCycleVizMode = () => {};

export default function IpodShell() {
	const [stackState, dispatchStack] = useReducer(screenStackReducer, initialScreenStack);
	const screen = currentScreen(stackState);
	const { nowMs, getNowMs, clockPaused, tzOffset } = useFineClock();
	const { paused, pause, resume } = useClassicyDateTime();
	const { connected, mp3Items, sources, subscribeMp3, unsubscribeMp3 } =
		useContext(MediaStreamContext);

	// biome-ignore lint/correctness/useExhaustiveDependencies: mount-only subscription
	useEffect(() => {
		subscribeMp3(APP_ID);
		return () => unsubscribeMp3(APP_ID);
	}, [subscribeMp3, unsubscribeMp3]);

	const [activeStationKey, setActiveStationKey] = useState<string>("");
	const stations = useMemo(
		() => mergeWithSources(sources.audio, mp3Items),
		[sources.audio, mp3Items],
	);
	const activeStation =
		stations.find((s) => s.key === activeStationKey) ?? null;

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

	const wheel = useClickWheel({
		onScroll: (steps) => screenHandlersRef.current.onScroll?.(steps),
		onSelect: () => screenHandlersRef.current.onSelect?.(),
		onPrev: () => screenHandlersRef.current.onPrev?.(),
		onNext: () => screenHandlersRef.current.onNext?.(),
		onMenu: () => dispatchStack({ type: "pop" }),
		onPlayPause: () => (paused ? resume() : pause()),
	});

	const tuneStation = useCallback((key: string) => {
		setActiveStationKey(key);
	}, []);

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
								{activeStation && (
									<span className={paused ? "ipodHeaderPause" : "ipodHeaderPlay"} />
								)}
								{clockLabel}
							</span>
						</div>
						{/* The menu, About, and Time Travel all work without the stream —
						    only data screens gate on the connection (RadioScreen shows
						    its own Connecting… state). */}
						<div className="ipodScreenBody" key={screen}>
							{screen === "menu" && (
								<MainMenu hasActiveStation={activeStation !== null} />
							)}
							{screen === "about" && <AboutScreen />}
							{screen === "radio" && (
								<RadioScreen
									stations={stations}
									nowMs={nowMs}
									activeStationKey={activeStationKey}
									onTune={tuneStation}
									connected={connected}
								/>
							)}
							{screen === "nowPlaying" && (
								<NowPlayingScreen
									station={activeStation}
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
						/>
					)}
				</ScreenNavContext.Provider>
			</WheelContext.Provider>
		</div>
	);
}
