// Persistence for the iPod shell's body color (Settings → Color). The five
// options are the first-generation iPod mini's anodized aluminum finishes.
// Same throw-safe localStorage-mirror pattern as nowPlayingStore.ts: storage
// that throws (private-mode Safari) degrades to session-only behavior, and a
// stored value is re-validated on load because localStorage survives deploys.

export const IPOD_COLORS = ["silver", "gold", "blue", "pink", "green"] as const;

export type IpodColor = (typeof IPOD_COLORS)[number];

export const DEFAULT_IPOD_COLOR: IpodColor = "silver";

const STORAGE_KEY = "rt911IpodColor";

function isIpodColor(v: unknown): v is IpodColor {
	return typeof v === "string" && (IPOD_COLORS as readonly string[]).includes(v);
}

export function loadIpodColor(): IpodColor {
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		return isIpodColor(raw) ? raw : DEFAULT_IPOD_COLOR;
	} catch {
		return DEFAULT_IPOD_COLOR;
	}
}

export function saveIpodColor(color: IpodColor): void {
	try {
		window.localStorage.setItem(STORAGE_KEY, color);
	} catch {
		// Storage unavailable: the chosen color is session-only.
	}
}
