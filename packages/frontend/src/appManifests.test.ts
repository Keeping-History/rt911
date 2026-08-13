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

	it("exposes no scriptable actions (parity with the empty pre-manifest allowlist)", () => {
		expect(listScriptableActions()).toEqual([]);
	});
});
