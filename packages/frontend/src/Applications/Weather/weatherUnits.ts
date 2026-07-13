// US-customary unit conversions for METAR/almanac display. All inputs are the
// raw metric values the weather channel/almanac ship (°C, kt, km, hPa) — the
// Weather app is US-audience-facing, so every number the UI shows the user
// goes through one of these first.

// Celsius → Fahrenheit, one decimal place (matches NWS display convention).
export function cToF(c: number): number {
	return Math.round(((c * 9) / 5 + 32) * 10) / 10;
}

// Knots → mph, rounded to the nearest whole number (NWS wind display convention).
export function ktToMph(kt: number): number {
	return Math.round(kt * 1.15078);
}

// Kilometers → miles, rounded to the nearest whole number (visibility display;
// callers format "10" for anything ≥10mi, matching METAR's visibility cap).
export function kmToMiles(km: number): number {
	return Math.round(km * 0.621371);
}

// 16-point compass rose from a wind direction in degrees (0-360, 0/360 = N).
const COMPASS_POINTS = [
	"N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
	"S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
] as const;

export function degToCompass(deg: number): string {
	const normalized = ((deg % 360) + 360) % 360;
	const index = Math.round(normalized / 22.5) % 16;
	return COMPASS_POINTS[index];
}

// Hectopascals (millibars) → inches of mercury, two decimal places (standard
// US altimeter-setting display, e.g. "29.92").
export function hpaToInHg(hpa: number): number {
	return Math.round(hpa * 0.0295299830714 * 100) / 100;
}
