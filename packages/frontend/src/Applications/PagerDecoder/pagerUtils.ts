import type { PagerDecoderFilter } from "./PagerDecoderContext";

export interface PagerRecord {
	timestamp: string;
	provider: string;
	recipient_id: string;
	id_type: string;
	channel: string;
	mode: string;
	message: string;
}

/**
 * Extract an HH:MM:SS time key from an ISO timestamp's UTC fields. The streamer
 * positions every item against the virtual clock (MediaStreamProvider reveals
 * items by `localDate`, which is the displayed wall-clock expressed in UTC), so a
 * pager item's start_date already carries the wall-clock the user should see —
 * applying a timezone offset here would double-count it. Returns "" for an
 * unparseable timestamp.
 */
export function isoToTimeKey(iso: string): string {
	const ms = new Date(iso).getTime();
	if (Number.isNaN(ms)) return "";
	const d = new Date(ms);
	const h = String(d.getUTCHours()).padStart(2, "0");
	const m = String(d.getUTCMinutes()).padStart(2, "0");
	const s = String(d.getUTCSeconds()).padStart(2, "0");
	return `${h}:${m}:${s}`;
}

/** Extract HH:MM:SS from a "YYYY-MM-DD HH:MM:SS" timestamp string. Returns "" if malformed. */
export function extractTimeKey(timestamp: string): string {
	const parts = timestamp.split(" ");
	if (parts.length !== 2) return "";
	const time = parts[1];
	if (!/^\d{2}:\d{2}:\d{2}$/.test(time)) return "";
	return time;
}

/** Parse one JSONL line. Returns null if non-ALPHA, empty message, or malformed. */
export function parseJsonlLine(line: string): PagerRecord | null {
	if (!line.trim()) return null;
	try {
		const record = JSON.parse(line) as Record<string, unknown>;
		if (record.mode !== "ALPHA") return null;
		const message = record.message;
		if (typeof message !== "string" || message.trim() === "") return null;
		return {
			timestamp: String(record.timestamp ?? ""),
			provider: String(record.provider ?? ""),
			recipient_id: String(record.recipient_id ?? ""),
			id_type: String(record.id_type ?? ""),
			channel: String(record.channel ?? ""),
			mode: "ALPHA",
			message,
		};
	} catch {
		return null;
	}
}

/**
 * Match a value against a wildcard pattern using `*` as a multi-character
 * wildcard. Empty pattern matches everything. Case-insensitive.
 */
export function matchesWildcard(value: string, pattern: string): boolean {
	if (!pattern) return true;
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`, "i").test(value);
}

/** Return true if a record passes all active filter criteria. */
export function matchesFilter(
	record: PagerRecord,
	filter: PagerDecoderFilter,
): boolean {
	if (filter.provider && record.provider !== filter.provider) return false;
	if (filter.id_type && record.id_type !== filter.id_type) return false;
	if (filter.channel && record.channel !== filter.channel) return false;
	if (filter.mode && record.mode !== filter.mode) return false;
	if (
		filter.recipient_id &&
		!matchesWildcard(record.recipient_id, filter.recipient_id)
	)
		return false;
	if (filter.message && !matchesWildcard(record.message, filter.message))
		return false;
	return true;
}
