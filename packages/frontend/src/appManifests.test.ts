// packages/frontend/src/appManifests.test.ts
//
// Deliberately NO vi.mock("classicy"): these tests exercise the real manifest
// registry that each context module writes into at import time. Importing a
// context module below runs its registerApp() side effect.
import { describe, expect, it } from "vitest";
import { getAppManifest, listScriptableActions } from "classicy";

import "./Applications/TV/TVContext";

// [appId, expected prefixes, spot-checked action types, has a state schema]
const CASES: Array<[string, string[], string[], boolean]> = [
	[
		"TV.app",
		["ClassicyAppTV"],
		["ClassicyAppTVTuneChannel", "ClassicyAppTVSetGridState", "ClassicyAppTVSetChannelOrder"],
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
