// Persistence for the iPod shell's tuned "now playing" source, so a phone
// that is refreshed or closed and reopened comes back with the same radio
// station or TV channel playing (the virtual clock already survives reloads
// via classicy's persisted store, so the media resumes at the moment the
// page went away). Same localStorage-mirror pattern as
// Applications/Alerts/alertsSettings.ts: throw-safe accessors so private-mode
// Safari (where storage access throws) degrades to session-only behavior.
//
// The stored value is re-validated on load — localStorage survives deploys,
// so treat it as untrusted input and fall back to "nothing tuned" on any
// shape mismatch rather than letting a stale write crash boot.

/** The single "now playing" source — tuning either kind evicts the other,
 *  which is the whole one-at-a-time rule (design decision 2026-07-15). */
export type NowPlayingSource =
	| { kind: "radio"; key: string }
	| { kind: "tv"; id: number };

const STORAGE_KEY = "rt911IpodNowPlaying";

function isNowPlayingSource(v: unknown): v is NowPlayingSource {
	if (typeof v !== "object" || v === null) return false;
	const s = v as Record<string, unknown>;
	if (s.kind === "radio") return typeof s.key === "string" && s.key.length > 0;
	if (s.kind === "tv") return typeof s.id === "number" && Number.isFinite(s.id);
	return false;
}

export function loadNowPlaying(): NowPlayingSource | null {
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return null;
		const parsed: unknown = JSON.parse(raw);
		return isNowPlayingSource(parsed) ? parsed : null;
	} catch {
		// Storage unavailable (private-mode Safari) or corrupt JSON: boot untuned.
		return null;
	}
}

export function saveNowPlaying(source: NowPlayingSource | null): void {
	try {
		if (source === null) window.localStorage.removeItem(STORAGE_KEY);
		else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(source));
	} catch {
		// Storage unavailable: the tuned source is session-only.
	}
}
