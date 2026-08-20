// Pure color math for tag pills, kept out of the component file so the .tsx
// only exports a component (react-refresh) — same split as radioScannerSettings.ts.

// Parse "#rgb" or "#rrggbb" into [r,g,b] (0..255), or null if not a valid hex.
export function parseHex(hex: string | null): [number, number, number] | null {
	if (typeof hex !== "string") return null;
	const h = hex.trim().replace(/^#/, "");
	const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
	if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
	return [
		parseInt(full.slice(0, 2), 16),
		parseInt(full.slice(2, 4), 16),
		parseInt(full.slice(4, 6), 16),
	];
}

// Pill background + a black/white text color chosen for contrast against it.
// Falls back to theme vars (already a readable pairing) when the tag has no
// valid color, so author colors stay legible in both light and dark themes.
export function pillColors(hex: string | null): { background: string; text: string } {
	const rgb = parseHex(hex);
	if (!rgb) return { background: "var(--color-theme-05)", text: "var(--color-theme-06)" };
	const [r, g, b] = rgb;
	const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	return {
		background: `rgb(${r}, ${g}, ${b})`,
		text: luminance > 0.6 ? "#000000" : "#ffffff",
	};
}
