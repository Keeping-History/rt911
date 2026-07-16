// Pure playlist engine — no React, no classicy. evaluate() answers "what should
// the world look like at this clock position" (idempotent); collectCrossings()
// yields the one-shot events between two tick positions. Only natural ticking
// fires events; the provider enforces that by what it passes here.
import {
	playlistUtcMs,
	type MediaEntry,
	type PlaylistApp,
	type PlaylistDefinition,
} from "./playlistTypes";

export interface RulesSnapshot {
	disabledApps: ReadonlySet<string>;
	isItemAvailable: (app: PlaylistApp, itemId: string) => boolean;
	lockedFocus: ReadonlyMap<PlaylistApp, string>;
	lockedSettings: ReadonlyMap<string, Record<string, unknown>>;
	browserShouldBe: { open: true; url: string } | { open: false };
}

export const ALLOW_ALL: RulesSnapshot = {
	disabledApps: new Set(),
	isItemAvailable: () => true,
	lockedFocus: new Map(),
	lockedSettings: new Map(),
	browserShouldBe: { open: false },
};

// Half-open window [start, end); a missing bound is unbounded.
const withinWindow = (e: MediaEntry, nowMs: number): boolean =>
	(e.start === undefined || playlistUtcMs(e.start) <= nowMs) &&
	(e.end === undefined || nowMs < playlistUtcMs(e.end));

export function evaluate(def: PlaylistDefinition | null, nowMs: number): RulesSnapshot {
	if (!def) return ALLOW_ALL;

	const disabledApps = new Set<string>();
	const lockedSettings = new Map<string, Record<string, unknown>>();
	const lockedFocus = new Map<PlaylistApp, string>();
	const mediaByApp = new Map<PlaylistApp, MediaEntry[]>();
	let browser: RulesSnapshot["browserShouldBe"] = { open: false };
	let browserAt = Number.NEGATIVE_INFINITY;

	for (const e of def.entries) {
		switch (e.kind) {
			case "app":
				disabledApps.add(e.appId);
				break;
			case "settings":
				if (e.locked) lockedSettings.set(e.appId, e.values);
				break;
			case "media": {
				const list = mediaByApp.get(e.app) ?? [];
				list.push(e);
				mediaByApp.set(e.app, list);
				if (e.focus === "locked" && withinWindow(e, nowMs)) lockedFocus.set(e.app, e.itemId);
				break;
			}
			case "browser": {
				const atMs = playlistUtcMs(e.at);
				const closeMs =
					e.closeAt === undefined ? Number.POSITIVE_INFINITY : playlistUtcMs(e.closeAt);
				if (atMs <= nowMs && nowMs < closeMs && atMs >= browserAt) {
					browser = { open: true, url: e.url };
					browserAt = atMs;
				}
				break;
			}
			default:
				break;
		}
	}

	const isItemAvailable = (app: PlaylistApp, itemId: string): boolean => {
		const lc = itemId.toLowerCase();
		const matching = (mediaByApp.get(app) ?? []).filter((m) => m.itemId.toLowerCase() === lc);
		if (matching.length === 0) return def.mode === "annotate";
		return matching.some((m) => withinWindow(m, nowMs));
	};

	return { disabledApps, isItemAvailable, lockedFocus, lockedSettings, browserShouldBe: browser };
}

export type TriggerEvent =
	| { kind: "jump"; atMs: number; to: string }
	| { kind: "file"; atMs: number; path: string }
	| { kind: "focus"; atMs: number; app: PlaylistApp; itemId: string; mode: "once" | "locked" };

export function collectCrossings(
	def: PlaylistDefinition | null,
	prevMs: number,
	nowMs: number,
): TriggerEvent[] {
	if (!def || nowMs <= prevMs) return [];
	const out: TriggerEvent[] = [];
	for (const e of def.entries) {
		if (e.kind === "jump") {
			const atMs = playlistUtcMs(e.at);
			if (prevMs < atMs && atMs <= nowMs) out.push({ kind: "jump", atMs, to: e.to });
		} else if (e.kind === "file") {
			const atMs = playlistUtcMs(e.at);
			if (prevMs < atMs && atMs <= nowMs) out.push({ kind: "file", atMs, path: e.path });
		} else if (e.kind === "media" && e.focus !== undefined && e.start !== undefined) {
			const atMs = playlistUtcMs(e.start);
			if (prevMs < atMs && atMs <= nowMs) {
				out.push({ kind: "focus", atMs, app: e.app, itemId: e.itemId, mode: e.focus });
			}
		}
	}
	return out.sort((a, b) => a.atMs - b.atMs);
}

// Focus entries whose window contains nowMs — fired once when the provider
// activates (page load / late join / refresh), covering entries with no start.
export function initialFocusEvents(
	def: PlaylistDefinition | null,
	nowMs: number,
): TriggerEvent[] {
	if (!def) return [];
	const out: TriggerEvent[] = [];
	for (const e of def.entries) {
		if (e.kind === "media" && e.focus !== undefined && withinWindow(e, nowMs)) {
			out.push({
				kind: "focus",
				atMs: e.start === undefined ? nowMs : playlistUtcMs(e.start),
				app: e.app,
				itemId: e.itemId,
				mode: e.focus,
			});
		}
	}
	return out;
}
