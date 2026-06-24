import { describe, expect, it, vi } from "vitest";
import { keepAudioContextAlive } from "./audioContextKeepAlive";

// Minimal fakes: an AudioContext and a document that only expose the surface the
// helper uses. Both are EventTargets so we can drive real events through them.
class FakeCtx extends EventTarget {
	state: AudioContextState = "suspended";
	resume = vi.fn(async () => {
		this.state = "running";
		this.dispatchEvent(new Event("statechange"));
	});
}

class FakeDoc extends EventTarget {
	visibilityState: DocumentVisibilityState = "visible";
}

describe("keepAudioContextAlive", () => {
	it("resumes a suspended context when the tab becomes visible", () => {
		const ctx = new FakeCtx();
		const doc = new FakeDoc();
		keepAudioContextAlive(ctx, doc);

		// Simulate returning to the tab while suspended (the bug scenario).
		doc.visibilityState = "visible";
		doc.dispatchEvent(new Event("visibilitychange"));
		expect(ctx.resume).toHaveBeenCalledTimes(1);
	});

	it("does not resume while the tab is hidden via visibilitychange", () => {
		const ctx = new FakeCtx();
		const doc = new FakeDoc();
		keepAudioContextAlive(ctx, doc);

		doc.visibilityState = "hidden";
		doc.dispatchEvent(new Event("visibilitychange"));
		expect(ctx.resume).not.toHaveBeenCalled();
	});

	it("resumes when the context itself reports a suspended state", () => {
		const ctx = new FakeCtx();
		const doc = new FakeDoc();
		keepAudioContextAlive(ctx, doc);

		// The browser suspended it (e.g. backgrounding) — statechange fires.
		ctx.state = "suspended";
		ctx.dispatchEvent(new Event("statechange"));
		expect(ctx.resume).toHaveBeenCalled();
	});

	it("is edge-triggered: a running context is left alone (no resume loop)", () => {
		const ctx = new FakeCtx();
		const doc = new FakeDoc();
		keepAudioContextAlive(ctx, doc);

		ctx.state = "running";
		ctx.dispatchEvent(new Event("statechange"));
		expect(ctx.resume).not.toHaveBeenCalled();
	});

	it("removes its listeners on cleanup", () => {
		const ctx = new FakeCtx();
		const doc = new FakeDoc();
		const stop = keepAudioContextAlive(ctx, doc);
		stop();

		ctx.state = "suspended";
		ctx.dispatchEvent(new Event("statechange"));
		doc.dispatchEvent(new Event("visibilitychange"));
		expect(ctx.resume).not.toHaveBeenCalled();
	});
});
