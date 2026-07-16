// Playlist definition schema — see plans/2026-07-16-teacher-playlists-design.md.
// Pure data module: no React, no classicy.

export type PlaylistApp = "tv" | "radio" | "news" | "flights";

export const PLAYLIST_APPS: readonly PlaylistApp[] = ["tv", "radio", "news", "flights"];

export interface MediaEntry {
	kind: "media";
	app: PlaylistApp;
	itemId: string; // channel source slug / station slug / news doc id / flight callsign
	start?: string; // virtual-clock UTC ISO; omitted = from the beginning
	end?: string; //                          omitted = until the end
	focus?: "once" | "locked";
}

export interface AppEntry {
	kind: "app";
	appId: string; // e.g. "TimeMachine.app"
	disabled: true;
}

export interface SettingsEntry {
	kind: "settings";
	appId: string;
	values: Record<string, unknown>; // merged into apps[appId].data
	locked?: boolean; // default false = boot seed only
}

export interface FileEntry {
	kind: "file";
	path: string; // ClassicyFileSystem path, e.g. "Documents:Newspapers:x.pdf"
	at: string;
}

export interface JumpEntry {
	kind: "jump";
	at: string; // when the clock crosses this…
	to: string; // …set it to this
}

export interface BrowserEntry {
	kind: "browser";
	url: string;
	at: string;
	closeAt?: string;
}

export type PlaylistEntry =
	| MediaEntry
	| AppEntry
	| SettingsEntry
	| FileEntry
	| JumpEntry
	| BrowserEntry;

export interface PlaylistDefinition {
	version: 1;
	mode: "restrict" | "annotate";
	entries: PlaylistEntry[];
}

// Directus stores datetimes without a timezone suffix; a bare value is a UTC
// wall-clock time, so append "Z" — same rule as TimeMachine/setVirtualClock.ts.
const HAS_ZONE = /[zZ]$|[+-]\d\d:?\d\d$/;

export function playlistUtcMs(s: string): number {
	const trimmed = s.trim();
	const ms = new Date(HAS_ZONE.test(trimmed) ? trimmed : `${trimmed}Z`).getTime();
	if (Number.isNaN(ms)) throw new Error(`Unparseable playlist UTC date: "${s}"`);
	return ms;
}
