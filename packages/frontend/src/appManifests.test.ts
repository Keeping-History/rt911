// packages/frontend/src/appManifests.test.ts
//
// Deliberately NO vi.mock("classicy"): these tests exercise the real manifest
// registry that each context module writes into at import time. Importing a
// context module below runs its registerApp() side effect.
import { describe, expect, it } from "vitest";
import { getAppManifest, listScriptableActions } from "classicy";

import "./Applications/TV/TVContext";
import "./Applications/FlightTracker/flightMapSettings";
import "./Applications/FlightTracker/flightTrackerCommands";
import "./Applications/Browser/BrowserContext";
import "./Applications/RadioScanner/RadioScannerContext";
import "./Applications/Weather/weatherSettings";
import "./Applications/TimeMachine/timeMachineSettings";
import "./Applications/Feedback/FeedbackContext";
import "./Applications/README/ReadmeContext";
import "./Applications/News/NewsContext";
import "./Applications/PagerDecoder/PagerDecoderContext";
import "./Applications/PlaylistEditor/PlaylistEditorContext";
import "./Providers/Playlist/playlistStoreActions";

// [appId, expected prefixes, spot-checked action types, has a state schema]
const CASES: Array<[string, string[], string[], boolean]> = [
	[
		"TV.app",
		["ClassicyAppTV"],
		["ClassicyAppTVTuneChannel", "ClassicyAppTVSetGridState", "ClassicyAppTVSetChannelOrder"],
		true,
	],
	[
		"FlightTracker.app",
		["ClassicyAppFlightTracker", "ClassicyAppFlightRemote"],
		["ClassicyAppFlightTrackerSetMapSettings", "ClassicyAppFlightRemoteFocus"],
		true,
	],
	[
		"Browser.app",
		["ClassicyAppBrowser"],
		["ClassicyAppBrowserNavigate", "ClassicyAppBrowserAddFavorite", "ClassicyAppBrowserClearHistory"],
		true,
	],
	[
		"RadioScanner.app",
		["ClassicyAppRadioScanner"],
		["ClassicyAppRadioScannerTuneStation", "ClassicyAppRadioScannerSetSettings"],
		true,
	],
	[
		"Weather.app",
		["ClassicyAppWeather"],
		["ClassicyAppWeatherSetLoopSettings", "ClassicyAppWeatherSetMapSettings"],
		true,
	],
	["TimeMachine.app", ["ClassicyAppTimeMachine"], ["ClassicyAppTimeMachineSetSettings"], true],
	["Feedback.app", ["ClassicyAppFeedback"], ["ClassicyAppFeedbackSetGithub"], true],
	["Readme.app", ["ClassicyAppReadme"], ["ClassicyAppReadmeSetSettings"], true],
	["News.app", ["ClassicyAppNews"], ["ClassicyAppNewsFocusItem", "ClassicyAppNewsSetOpenDocuments"], true],
	[
		"PagerDecoder.app",
		["ClassicyAppPagerDecoder"],
		["ClassicyAppPagerDecoderInitSettings", "ClassicyAppPagerDecoderUpdateSettings"],
		true,
	],
	[
		"PlaylistEditor.app",
		["ClassicyAppPlaylist", "ClassicyAppTimelineZoom"],
		["ClassicyAppPlaylistMergeData", "ClassicyAppTimelineZoomSet"],
		true,
	],
];

describe("app manifests", () => {
	it.each(CASES)(
		"%s registers prefixes, described actions, and state",
		(appId, prefixes, actionTypes, hasState) => {
			const m = getAppManifest(appId);
			expect(m, `${appId} has no manifest — registerApp not called?`).toBeDefined();
			expect(m!.prefixes).toEqual(expect.arrayContaining(prefixes));
			for (const type of actionTypes) {
				expect(
					m!.actions[type]?.description,
					`${type} missing or missing description`,
				).toBeTruthy();
			}
			if (hasState) expect(m!.state).toBeDefined();
		},
	);

	// `scriptable: true` exposes an action to untrusted HyperCard stack scripts,
	// so this is an allowlist, not a snapshot. It was `[]` until classicy 0.72.5
	// shipped a built-in ScreenSaver whose Activate action is scriptable — this
	// repo still marks nothing of its own scriptable.
	//
	// Compared as `appId:type` rather than whole objects so a wording change to
	// classicy's description does not fail the build, while any NEW scriptable
	// action still does. Widening this to "just assert it's an array" would throw
	// away the only thing that makes the allowlist a control.
	it("exposes only classicy's built-in ScreenSaver activate as scriptable", () => {
		expect(listScriptableActions().map((a) => `${a.appId}:${a.type}`)).toEqual([
			"ScreenSaver.app:ClassicyAppScreenSaverActivate",
		]);
	});

	// classicy routes each action to exactly ONE handler — the first registered
	// prefix the action type starts with. So if one prefix is a prefix of
	// another, every action in the longer namespace is delivered to the shorter
	// namespace's handler instead, which typically ignores it and returns the
	// store unchanged. Nothing throws; the feature just silently does nothing,
	// and which handler wins depends on module import order.
	//
	// "ClassicyAppPlaylist" vs a proposed "ClassicyAppPlaylistEditor" hit exactly
	// this, which is why the timeline's actions live under
	// "ClassicyAppTimelineZoom".
	it("registers no prefix that is a prefix of another", () => {
		const prefixes = [...new Set(CASES.flatMap(([, p]) => p))];
		const overlaps = prefixes.flatMap((a) =>
			prefixes.filter((b) => b !== a && b.startsWith(a)).map((b) => `${a} swallows ${b}`),
		);
		expect(overlaps).toEqual([]);
	});
});
