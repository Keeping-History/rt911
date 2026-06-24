// Keep a station's AudioContext from leaving its audio muted after a tab switch.
//
// The Radio Scanner routes each playing station through an AudioContext (the
// visualizer calls createMediaElementSource, which permanently reroutes the
// element's output through the Web Audio graph). Browsers suspend a backgrounded
// tab's AudioContext to save power, and a suspended context produces no sound —
// so switching browser tabs silenced the audio and nothing brought it back
// (audiomotion-analyzer only resumes on a click).
//
// This resumes the context whenever the tab returns to the foreground and
// whenever the context reports a suspended state. The statechange handler is
// edge-triggered (it fires only on an actual state transition), so a context the
// browser refuses to resume while hidden settles at "suspended" without looping —
// and is then resumed the moment the tab becomes visible again.

export interface ResumableAudioContext {
	readonly state: AudioContextState;
	resume(): Promise<void>;
	addEventListener(type: "statechange", listener: () => void): void;
	removeEventListener(type: "statechange", listener: () => void): void;
}

interface VisibilityDoc {
	readonly visibilityState: DocumentVisibilityState;
	addEventListener(type: "visibilitychange", listener: () => void): void;
	removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export function keepAudioContextAlive(
	ctx: ResumableAudioContext,
	doc: VisibilityDoc = document,
): () => void {
	const resumeIfSuspended = () => {
		if (ctx.state === "suspended") ctx.resume().catch(() => {});
	};
	const onVisible = () => {
		if (doc.visibilityState === "visible") resumeIfSuspended();
	};

	doc.addEventListener("visibilitychange", onVisible);
	ctx.addEventListener("statechange", resumeIfSuspended);

	return () => {
		doc.removeEventListener("visibilitychange", onVisible);
		ctx.removeEventListener("statechange", resumeIfSuspended);
	};
}
