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
