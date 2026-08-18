// Mapping between playlist media catalogs and the desktop apps that own them,
// plus name/icon metadata for programmatic open/close dispatches.
import { ClassicyIcons } from "classicy";
import { BROADCAST_STATIONS } from "../../Applications/radio-core/stationGrouping";
import type { PlaylistApp } from "./playlistTypes";

export const PLAYLIST_APP_IDS: Record<PlaylistApp, string> = {
	tv: "TV.app",
	radio: "RadioScanner.app",
	news: "News.app",
	flights: "FlightTracker.app",
};

/**
 * The app a focus entry actually opens. The "radio" catalog is split across
 * two desktop apps: continuous broadcast stations (WCBS/WINS) live in the
 * Radio Tuner, every other station in the Radio Scanner. Station slugs match
 * case-insensitively, same as the apps' own tune commands.
 */
export function playlistFocusAppId(app: PlaylistApp, itemId: string): string {
	if (app === "radio" && BROADCAST_STATIONS.has(itemId.toUpperCase())) {
		return "RadioTuner.app";
	}
	return PLAYLIST_APP_IDS[app];
}

export const PERMISSION_DENIED = "You don't have permission to open this app.";

// Names mirror each component's `appName` so menu entries created by an
// open/close dispatch match the ones the app itself creates.
const APP_NAMES: Record<string, string> = {
	"TV.app": "TV",
	"RadioScanner.app": "Radio Scanner",
	"RadioTuner.app": "Radio Tuner",
	"News.app": "News",
	"FlightTracker.app": "Flight Tracker",
	"Browser.app": "Browser",
	"TimeMachine.app": "Time Machine",
};

// ClassicyIcons.applications.<key>.app per component. Resolved LAZILY at call
// time: FlightTracker/TimeMachine register their icons into the shared registry
// at their own module scope, so a static table here could read undefined
// depending on import order.
const APP_ICON_KEYS: Record<string, string> = {
	"TV.app": "epg",
	"RadioScanner.app": "radioScanner",
	"RadioTuner.app": "radio",
	"News.app": "news",
	"FlightTracker.app": "flightTracker",
	"Browser.app": "internetExplorer",
	"TimeMachine.app": "timeMachine",
};

export function playlistAppMeta(appId: string): { name: string; icon: string } {
	const key = APP_ICON_KEYS[appId];
	const registry = ClassicyIcons.applications as Record<
		string,
		{ app?: unknown } | undefined
	>;
	const icon = key ? String(registry[key]?.app ?? "") : "";
	return { name: APP_NAMES[appId] ?? appId, icon };
}
