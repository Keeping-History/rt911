// The provider tree shared by both boot branches (DesktopRoot / MobileRoot).
// Extracted from app.tsx so the entry chunk can lazy-load one branch or the
// other: phones stop parsing the desktop's application code just to render
// the iPod shell. Everything here mounts in the SAME commit as the branch's
// shell component (Desktop or IpodShell), which preserves the invariant
// documented in DesktopRoot.tsx — ClassicyDesktop must never mount a tick
// after ClassicyAppManagerProvider.
//
// Classicy 3 draws nothing until an Appearance Package registers (it shows its
// "No Appearance Package is loaded" screen instead), so the Appearance Packages
// are imported first, before anything renders. Importing @classicy/classicy
// injects its own stylesheet, so there is no CSS import here any more.
//
// Both looks are registered, and Classicy's own Appearance Manager control
// panel switches between them (its Packages tab calls `changePackage`) — this
// app writes no switching code of its own. Platinum stays what a fresh desktop
// draws: the core's CLASSICY_DEFAULT_APPEARANCE_PACKAGE_ID is "platinum", and
// every unregistered or stale stored id resolves back to it, so registering
// System 7 adds a choice without moving the default.
//
// Import order does not pick the default, but keep Platinum first anyway: it is
// the product's own look, and the fallback when a package is missing is "the
// default, else the first registered".
import "@classicy/appearance-platinum";
import "@classicy/appearance-system7";
import type { ReactNode } from "react";
import { ClassicyAppManagerProvider, registerClassicyFileSystemAdapter } from "@classicy/classicy";
import { DefaultFileSystem } from "../data/DefaultFileSystem";
import { defaultFileSystemSeedMigrations } from "../data/defaultFileSystemSeedMigrations";
import { GA_MEASUREMENT_ID, isProductionHost } from "../lib/analytics";
import { AuthProvider } from "../Providers/Auth/AuthProvider";
import { directusFilesystemAdapter } from "../Providers/FilesystemSync/directusFilesystemAdapter";
import { FilesystemSyncProvider } from "../Providers/FilesystemSync/FilesystemSyncProvider";
import { MediaStreamProvider } from "../Providers/MediaStream/MediaStreamProvider";
import { PlaylistProvider } from "../Providers/Playlist/PlaylistProvider";

// Sync the signed-in user's filesystem to Directus/Wasabi. Snapshot mode with a
// 3s debounce so rapid edits coalesce into one upload; anonymous users are a no-op.
registerClassicyFileSystemAdapter(directusFilesystemAdapter, { snapshotDebounceMs: 3000 });

export function AppProviders({ children }: { children: ReactNode }) {
	return (
		<ClassicyAppManagerProvider
			// Desktop/mobile-branch analytics. The pages branch mounts outside this
			// provider and loads the same property itself — see lib/analytics.ts.
			// Empty outside production hostnames: classicy wires gaMeasurementIds
			// straight into its own GA plugin with no gating of its own, so dev/CI/
			// PR-preview hosts would otherwise report real hits into production GA.
			gaMeasurementIds={isProductionHost() ? [GA_MEASUREMENT_ID] : []}
			defaultFileSystem={DefaultFileSystem}
			defaultFileSystemMode="exclusive"
			defaultFileSystemSeedMigrations={defaultFileSystemSeedMigrations}
			defaultState={{
				System: {
					Manager: {
						DateAndTime: {
							// Boot the desktop clock at 8:40 AM US Eastern on
							// 2001-09-11 (EDT, UTC-4 → 12:40 UTC). Seed-only: applies
							// on a fresh visit; persisted state wins on reload.
							dateTime: "2001-09-11T12:40:00.000Z",
							timeZoneOffset: "-4",
							// Date & Time's Sync takes only the real-world time of
							// day and leaves the calendar date alone — this desktop
							// is pinned to 2001-09-11, so a plain Sync would drag it
							// to today and strand every app with no media to play.
							syncTimeOnly: true,
						},
						Applications: {
							apps: {
								"TV.app": {
									data: {
										// Hide lower-priority / non-US channels by default.
										// Users can re-enable any of these via TV Settings.
										disabledChannels: [
											"ANT1",
											"AZT",
											"BET",
											"CCTV4",
											"IRAQ",
											"MCM",
											"MSNBC",
											"PSC",
											"WETA",
										],
									},
								},
							},
						},
					},
				},
			}}
		>
			<PlaylistProvider>
				<AuthProvider>
					<FilesystemSyncProvider>
						<MediaStreamProvider>{children}</MediaStreamProvider>
					</FilesystemSyncProvider>
				</AuthProvider>
			</PlaylistProvider>
		</ClassicyAppManagerProvider>
	);
}
