// Per-channel RGB inverse of a #rrggbb hex color (255 - each channel). Used to
// paint POI labels as the literal inverse of the basemap background so they read
// against it (issue #310). Non-#rrggbb input is returned unchanged.
export function invertHex(hex: string): string {
	const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return hex;
	const n = Number.parseInt(m[1], 16);
	const r = 255 - ((n >> 16) & 255);
	const g = 255 - ((n >> 8) & 255);
	const b = 255 - (n & 255);
	return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}
