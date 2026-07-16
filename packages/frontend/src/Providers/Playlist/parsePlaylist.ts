// Validate an untrusted playlist document. Structurally invalid documents fail
// wholesale (definition: null); malformed entries are dropped individually with
// a warning; unknown kinds are ignored silently (forward compatibility).
import {
	PLAYLIST_APPS,
	playlistUtcMs,
	type PlaylistApp,
	type PlaylistDefinition,
	type PlaylistEntry,
} from "./playlistTypes";

export interface ParsedPlaylist {
	definition: PlaylistDefinition | null;
	warnings: string[];
}

const KNOWN_KINDS = new Set(["media", "app", "settings", "file", "jump", "browser"]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const validTime = (v: unknown): v is string => {
	if (typeof v !== "string") return false;
	try {
		playlistUtcMs(v);
		return true;
	} catch {
		return false;
	}
};

function parseEntry(raw: unknown, warn: (msg: string) => void): PlaylistEntry | null {
	if (!isRecord(raw) || typeof raw.kind !== "string") {
		warn(`entry is not an object with a kind: ${JSON.stringify(raw)}`);
		return null;
	}
	if (!KNOWN_KINDS.has(raw.kind)) return null; // unknown kind: silent skip
	switch (raw.kind) {
		case "media": {
			if (!PLAYLIST_APPS.includes(raw.app as PlaylistApp)) {
				warn(`media entry has unknown app "${String(raw.app)}"`);
				return null;
			}
			if (typeof raw.itemId !== "string" || raw.itemId === "") {
				warn("media entry missing itemId");
				return null;
			}
			if (raw.start !== undefined && !validTime(raw.start)) {
				warn(`media entry "${raw.itemId}" has bad start`);
				return null;
			}
			if (raw.end !== undefined && !validTime(raw.end)) {
				warn(`media entry "${raw.itemId}" has bad end`);
				return null;
			}
			if (raw.focus !== undefined && raw.focus !== "once" && raw.focus !== "locked") {
				warn(`media entry "${raw.itemId}" has bad focus`);
				return null;
			}
			return {
				kind: "media",
				app: raw.app as PlaylistApp,
				itemId: raw.itemId,
				...(raw.start !== undefined ? { start: raw.start as string } : {}),
				...(raw.end !== undefined ? { end: raw.end as string } : {}),
				...(raw.focus !== undefined ? { focus: raw.focus as "once" | "locked" } : {}),
			};
		}
		case "app":
			if (typeof raw.appId !== "string" || raw.disabled !== true) {
				warn("app entry needs appId and disabled: true");
				return null;
			}
			return { kind: "app", appId: raw.appId, disabled: true };
		case "settings":
			if (typeof raw.appId !== "string" || !isRecord(raw.values)) {
				warn("settings entry needs appId and values object");
				return null;
			}
			return {
				kind: "settings",
				appId: raw.appId,
				values: raw.values,
				...(raw.locked === true ? { locked: true } : {}),
			};
		case "file":
			if (typeof raw.path !== "string" || !validTime(raw.at)) {
				warn("file entry needs path and a valid at");
				return null;
			}
			return { kind: "file", path: raw.path, at: raw.at as string };
		case "jump":
			if (!validTime(raw.at) || !validTime(raw.to)) {
				warn("jump entry needs valid at and to");
				return null;
			}
			return { kind: "jump", at: raw.at as string, to: raw.to as string };
		case "browser":
			if (typeof raw.url !== "string" || !validTime(raw.at)) {
				warn("browser entry needs url and a valid at");
				return null;
			}
			if (raw.closeAt !== undefined && !validTime(raw.closeAt)) {
				warn(`browser entry "${raw.url}" has bad closeAt`);
				return null;
			}
			return {
				kind: "browser",
				url: raw.url,
				at: raw.at as string,
				...(raw.closeAt !== undefined ? { closeAt: raw.closeAt as string } : {}),
			};
		default:
			return null;
	}
}

// PlaylistApp → owning desktop app id, needed for the disable-wins cross-check.
const APP_IDS: Record<PlaylistApp, string> = {
	tv: "TV.app",
	radio: "RadioScanner.app",
	news: "News.app",
	flights: "FlightTracker.app",
};

export function parsePlaylist(raw: unknown): ParsedPlaylist {
	const warnings: string[] = [];
	const warn = (msg: string) => warnings.push(msg);

	if (
		!isRecord(raw) ||
		raw.version !== 1 ||
		(raw.mode !== "restrict" && raw.mode !== "annotate") ||
		!Array.isArray(raw.entries)
	) {
		return { definition: null, warnings: ["structurally invalid playlist document"] };
	}

	const entries = raw.entries
		.map((e) => parseEntry(e, warn))
		.filter((e): e is PlaylistEntry => e !== null);

	// Cross-checks. Disable wins: strip focus from media entries whose owning app
	// is disabled (the availability window itself still applies) and drop settings
	// entries for disabled apps entirely.
	const disabled = new Set(entries.filter((e) => e.kind === "app").map((e) => e.appId));
	const checked = entries
		.map((e): PlaylistEntry | null => {
			if (e.kind === "media" && e.focus && disabled.has(APP_IDS[e.app])) {
				warn(`focus on "${e.itemId}" ignored: ${APP_IDS[e.app]} is disabled`);
				const { focus, ...rest } = e;
				void focus;
				return rest;
			}
			if (e.kind === "settings" && disabled.has(e.appId)) {
				warn(`settings for disabled app ${e.appId} skipped`);
				return null;
			}
			if (e.kind === "jump" && playlistUtcMs(e.to) < playlistUtcMs(e.at)) {
				warn(`backward jump at ${e.at} → ${e.to} loops until interrupted`);
			}
			return e;
		})
		.filter((e): e is PlaylistEntry => e !== null);

	return {
		definition: { version: 1, mode: raw.mode, entries: checked },
		warnings,
	};
}
