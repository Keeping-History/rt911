import { Component, lazy, StrictMode, Suspense, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";
import { isMobileDevice } from "./Mobile/detectMobile";
import { runWhenIdle } from "./lib/runWhenIdle";
import { pagesRouteSlug } from "./Pages/route";

// The entry stays tiny and branch-blind: each boot surface is its own lazy
// chunk, so a phone parses the iPod shell's graph without the desktop's
// application code, and the desktop never waits on mobile code. The provider
// tree lives INSIDE DesktopRoot/MobileRoot (see boot/AppProviders.tsx) so
// ClassicyAppManagerProvider always mounts in the same commit as its shell —
// the lazy-ClassicyDesktop corruption documented in DesktopRoot.tsx cannot
// occur, because there is no provider-mounted-without-desktop tick.
const DesktopRoot = lazy(() => import("./DesktopRoot"));
const MobileRoot = lazy(() => import("./MobileRoot"));

// The CMS pages surface. Static chrome styled to resemble Classicy; mounts no
// ClassicyDesktop and no app manager, so it is safe as its own lazy chunk.
const PagesSite = lazy(() => import("./Pages/PagesSite"));

const mobile = isMobileDevice();

// A CMS page is present-day static content: it reads Directus directly and has
// nothing to do with the virtual clock, the streamer, playlists, auth, or the
// user filesystem. Branching here rather than inside the tree means visiting
// /about does not spin up a WebSocket to the streamer or boot the app manager.
const pageSlug = pagesRouteSlug(window.location.pathname);

// OpenReplay session replay. On phones it is deferred past boot: the tracker
// observes every DOM mutation from the moment it starts, and the iPod shell
// re-renders on each clock tick and stream frame — starting it during boot
// makes the first taps compete with recording overhead on top of script
// parse. Desktop and pages start immediately, as they always have. The
// dynamic import also keeps the tracker out of the entry chunk; openreplay.ts
// is a module singleton, so identifyUser()/track*() callers in the app see
// the same instance once this init runs.
const startTracker = () =>
	void import("./openreplay").then((m) => m.initTracker());
if (mobile && pageSlug === null) {
	runWhenIdle(startTracker);
} else {
	startTracker();
}

// If the mobile chunk fails to load (bad network, stale deploy) or the shell
// throws, fall back to the desktop branch — never a blank page. DesktopRoot
// mounts a fresh provider + desktop together, so the fallback is a clean boot.
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
		return this.state.failed ? <DesktopRoot /> : this.props.children;
	}
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Root element not found");

createRoot(rootElement).render(
	<StrictMode>
		<Suspense fallback={null}>
			{pageSlug !== null ? (
				<PagesSite />
			) : mobile ? (
				<MobileFallbackBoundary>
					<MobileRoot />
				</MobileFallbackBoundary>
			) : (
				<DesktopRoot />
			)}
		</Suspense>
	</StrictMode>,
);
