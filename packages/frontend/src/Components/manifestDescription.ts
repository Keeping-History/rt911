import { getAppManifest } from "classicy";

/**
 * Balloon-help copy for an app's desktop shortcut: the app's registered
 * manifest description (`registerApp({ description })`), so the shortcut
 * balloon and every other manifest-driven surface share one sentence.
 *
 * Passed as `ClassicyApp`'s `desktopIconBalloonHelp` — a bare string becomes
 * the balloon body, titled with the app's name. Returns undefined (no balloon)
 * when no manifest is registered; manifestDescription.test.ts enforces that
 * every desktop app actually registers a described manifest.
 *
 * Test-mock note: a test that fully mocks "classicy" for a component whose
 * graph reaches this module needs `getAppManifest: () => undefined` in the
 * factory (same hazard as `registerApp` — see frontend CLAUDE.md).
 */
export function manifestDescription(appId: string): string | undefined {
	return getAppManifest(appId)?.description;
}
