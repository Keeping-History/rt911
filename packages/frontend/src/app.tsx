import { Component, lazy, StrictMode, Suspense, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";
import "classicy/dist/classicy.css";
import { ClassicyAppManagerProvider } from "classicy";
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
import { AuthProvider } from "./Providers/Auth/AuthProvider";
import { MediaStreamProvider } from "./Providers/MediaStream/MediaStreamProvider";
import { PlaylistProvider } from "./Providers/Playlist/PlaylistProvider";
import { initTracker } from "./openreplay";

initTracker();

const IpodShell = lazy(() => import("./Mobile/IpodShell"));

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
createRoot(rootElement).render(
	<StrictMode>
		<ClassicyAppManagerProvider
			gaMeasurementIds={["G-YV25XK2Y3R"]}
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
				</AuthProvider>
			</PlaylistProvider>
		</ClassicyAppManagerProvider>
	</StrictMode>,
);
