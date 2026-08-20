import { Component, lazy, StrictMode, Suspense, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";
import "classicy/dist/classicy.css";
// Opt-in since classicy 0.70.0, which split every base64 @font-face rule out
// of classicy.css into this sibling stylesheet so consumers aren't forced to
// download ~900 kB of fonts they may not use. We DO use them — Chicago,
// Geneva, Monaco and Charcoal are the whole Platinum look — so we opt in.
// Dropping this import doesn't error, it just silently falls back to system
// fonts everywhere.
import "classicy/dist/fonts.css";
import { ClassicyAppManagerProvider, registerClassicyFileSystemAdapter } from "classicy";
import { directusFilesystemAdapter } from "./Providers/FilesystemSync/directusFilesystemAdapter";
import { FilesystemSyncProvider } from "./Providers/FilesystemSync/FilesystemSyncProvider";
import { DefaultFileSystem } from "./data/DefaultFileSystem";
// Desktop is imported EAGERLY on purpose: mounting ClassicyDesktop lazily
// (a tick after ClassicyAppManagerProvider) corrupts classicy's manager
// state — early dispatches hit a reducer that iterates state the desktop
// hasn't seeded yet, and every dispatch after that throws (windows can no
// longer open). Verified empirically 2026-07-14: `lazy(() =>
// import("./Desktop"))` alone reproduces it; a static import is clean.
// Re-splitting the desktop chunk for mobile is blocked on a classicy fix.
import Desktop from "./Desktop";
import { isMobileDevice } from "./Mobile/detectMobile";
import { GA_MEASUREMENT_ID } from "./lib/analytics";
import { pagesRouteSlug } from "./Pages/route";
import { AuthProvider } from "./Providers/Auth/AuthProvider";
import { MediaStreamProvider } from "./Providers/MediaStream/MediaStreamProvider";
import { PlaylistProvider } from "./Providers/Playlist/PlaylistProvider";
import { initTracker } from "./openreplay";

initTracker();

// Sync the signed-in user's filesystem to Directus/Wasabi. Snapshot mode with a
// 3s debounce so rapid edits coalesce into one upload; anonymous users are a no-op.
registerClassicyFileSystemAdapter(directusFilesystemAdapter, { snapshotDebounceMs: 3000 });

const IpodShell = lazy(() => import("./Mobile/IpodShell"));

// The CMS pages surface. Safe to lazy-load, unlike Desktop: it is static chrome
// styled to resemble Classicy and mounts no ClassicyDesktop, so the app-manager
// corruption described above does not apply.
const PagesSite = lazy(() => import("./Pages/PagesSite"));

// If the mobile chunk fails to load (bad network, stale deploy), fall back to
// the desktop branch — never a blank page.
class MobileFallbackBoundary extends Component<
	{ children: ReactNode },
	{ failed: boolean }
> {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	componentDidCatch(error: unknown) {
		console.error("iPod shell failed; falling back to desktop", error);
		// Lazy-chunk loads can fail transiently (a network blip on a phone;
		// vite's dep re-optimization reload in dev). Retry with one full page
		// reload before falling back to the desktop for good.
		if (!sessionStorage.getItem("ipodShellRetried")) {
			sessionStorage.setItem("ipodShellRetried", "1");
			window.location.reload();
		}
	}
	render() {
		return this.state.failed ? <Desktop /> : this.props.children;
	}
}

const mobile = isMobileDevice();

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Root element not found");

// A CMS page is present-day static content: it reads Directus directly and has
// nothing to do with the virtual clock, the streamer, playlists, auth, or the
// user filesystem. Branching here rather than inside the tree means visiting
// /about does not spin up a WebSocket to the streamer or boot the app manager.
const pageSlug = pagesRouteSlug(window.location.pathname);

createRoot(rootElement).render(
	pageSlug !== null ? (
		<StrictMode>
			<Suspense fallback={null}>
				<PagesSite />
			</Suspense>
		</StrictMode>
	) : (
	<StrictMode>
		<ClassicyAppManagerProvider
			// Desktop-branch analytics. The pages branch above mounts outside this
			// provider and loads the same property itself — see lib/analytics.ts.
			gaMeasurementIds={[GA_MEASUREMENT_ID]}
			defaultFileSystem={DefaultFileSystem}
			defaultFileSystemMode="exclusive"
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
						<MediaStreamProvider>
							<Suspense fallback={null}>
								{mobile ? (
									<MobileFallbackBoundary>
										<IpodShell />
									</MobileFallbackBoundary>
								) : (
									<Desktop />
								)}
							</Suspense>
						</MediaStreamProvider>
					</FilesystemSyncProvider>
				</AuthProvider>
			</PlaylistProvider>
		</ClassicyAppManagerProvider>
	</StrictMode>
	),
);
