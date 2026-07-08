// jsdom does not implement IntersectionObserver; react-marquee-text
// (NowPlayingList) requires it at mount. Minimal inert stub for tests.
class IntersectionObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
	takeRecords(): IntersectionObserverEntry[] {
		return [];
	}
	readonly root = null;
	readonly rootMargin = "";
	readonly thresholds: readonly number[] = [];
}

globalThis.IntersectionObserver =
	globalThis.IntersectionObserver ??
	(IntersectionObserverStub as unknown as typeof IntersectionObserver);

// jsdom does not implement ResizeObserver; FlightMap observes its container to
// call map.resize(). Minimal inert stub for tests.
class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}
globalThis.ResizeObserver =
	globalThis.ResizeObserver ??
	(ResizeObserverStub as unknown as typeof ResizeObserver);
