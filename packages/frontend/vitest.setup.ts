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

// jsdom requires --localstorage-file; polyfill in-memory localStorage for tests.
try {
	if (!window.localStorage || typeof window.localStorage.getItem !== "function") {
		throw new Error("localStorage not available");
	}
} catch {
	const store: Record<string, string> = {};

	Object.defineProperty(window, "localStorage", {
		value: {
			getItem(key: string): string | null {
				return store[key] ?? null;
			},
			setItem(key: string, value: string): void {
				store[key] = value;
			},
			removeItem(key: string): void {
				delete store[key];
			},
			clear(): void {
				for (const key in store) delete store[key];
			},
			key(index: number): string | null {
				const keys = Object.keys(store);
				return keys[index] ?? null;
			},
			get length(): number {
				return Object.keys(store).length;
			},
		},
		writable: false,
		configurable: true,
	});
}
