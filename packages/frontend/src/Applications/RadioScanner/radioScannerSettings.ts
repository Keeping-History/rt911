import type { ActionMessage } from "classicy";
import type { CSSProperties } from "react";

export const VIZ_MODES = ["Bars", "Spectrum", "Radial", "Wave"] as const;
export type VizMode = (typeof VIZ_MODES)[number];

export const isVizMode = (v: unknown): v is VizMode =>
	typeof v === "string" && (VIZ_MODES as readonly string[]).includes(v);

// Closed-caption appearance, mirroring the TV app's caption settings. Colors are
// packed 0xRRGGBB (ClassicyColorPicker-native) and split from their alpha so the
// picker and the opacity slider stay independent controls.
export interface CaptionStyle {
	/** CSS custom-property name for the font family, e.g. "--ui-font". */
	font: string;
	/** Text color, packed 0xRRGGBB. */
	color: number;
	/** Text alpha, 0..1. */
	colorOpacity: number;
	/** Background color, packed 0xRRGGBB. */
	bgColor: number;
	/** Background alpha, 0..1. */
	bgOpacity: number;
	/** Font-size scale, percent (100 = the base caption size). */
	size: number;
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
	font: "--ui-font",
	color: 0xffffff, // white
	colorOpacity: 1,
	bgColor: 0x000000, // black
	bgOpacity: 0.8,
	size: 100,
};

/** Selectable caption fonts as [CSS var, label]; same set the TV app offers. */
export const CAPTION_FONT_VARS: readonly [string, string][] = [
	["--header-font", "Header"],
	["--body-font", "Body"],
	["--ui-font", "UI"],
];

/** The base caption font size (in --ui-font-size units) that `size: 100` maps to. */
const CAPTION_BASE_SCALE = 1.5;

const rgba = (packed: number, opacity: number): string => {
	const r = (packed >> 16) & 0xff;
	const g = (packed >> 8) & 0xff;
	const b = packed & 0xff;
	return `rgba(${r}, ${g}, ${b}, ${opacity})`;
};

/**
 * Inline styles for the caption text span. Radio draws its own caption element
 * (audio has no <video> surface for the browser to paint ::cue onto), so the
 * packed-int colors and size percent become concrete CSS here.
 */
export const captionTextStyle = (style: CaptionStyle): CSSProperties => ({
	fontFamily: `var(${style.font})`,
	color: rgba(style.color, style.colorOpacity),
	backgroundColor: rgba(style.bgColor, style.bgOpacity),
	fontSize: `calc(var(--ui-font-size) * ${(CAPTION_BASE_SCALE * style.size) / 100})`,
});

// Waveform preferences (the Settings window + the overlay mode toggle).
// Ephemeral UI state (open windows, the settings draft) is NOT persisted;
// only the user's choices are — same split as timeMachineSettings.ts.
export interface RadioScannerSettings {
	/** Waveform display type; the overlay toggle cycles and persists it. */
	vizMode: VizMode;
	/** true = follow --color-theme-03/--color-theme-05 (live re-theming). */
	useThemeColors: boolean;
	/** Custom bright color, packed 0xRRGGBB — ClassicyColorPicker native. */
	colorBright: number;
	/** Custom dim (gradient end) color, packed 0xRRGGBB. */
	colorDim: number;
	/** Volume ceiling for all audio the app plays, percent 0..100. */
	maxVolume: number;
	/** Closed-caption appearance (the CC on/off toggle is separate, live state). */
	captionStyle: CaptionStyle;
}

export const DEFAULT_RADIO_SCANNER_SETTINGS: RadioScannerSettings = {
	vizMode: "Wave",
	useThemeColors: true,
	colorBright: 0x00d25a, // the pre-theme hardcoded bright green
	colorDim: 0x00b446, // the pre-theme hardcoded dim green
	maxVolume: 100, // no attenuation
	captionStyle: DEFAULT_CAPTION_STYLE,
};

/** Persist the whole settings object in one dispatch. */
export const radioScannerSetSettings = (
	settings: RadioScannerSettings,
): ActionMessage => ({
	type: "ClassicyAppRadioScannerSetSettings",
	settings,
});

// Stored state comes from localStorage, so a hand-edited or stale value
// could be anything; invalid fields fall back individually.
const isIntIn = (v: unknown, min: number, max: number): v is number =>
	typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

const isFraction = (v: unknown): v is number =>
	typeof v === "number" && v >= 0 && v <= 1;

/** Per-field fallback for a stored caption style; same tolerance as the rest. */
const readCaptionStyle = (
	stored: Partial<CaptionStyle> | undefined,
): CaptionStyle => {
	const s = stored ?? {};
	return {
		font: CAPTION_FONT_VARS.some(([v]) => v === s.font)
			? (s.font as string)
			: DEFAULT_CAPTION_STYLE.font,
		color: isIntIn(s.color, 0, 0xffffff)
			? s.color
			: DEFAULT_CAPTION_STYLE.color,
		colorOpacity: isFraction(s.colorOpacity)
			? s.colorOpacity
			: DEFAULT_CAPTION_STYLE.colorOpacity,
		bgColor: isIntIn(s.bgColor, 0, 0xffffff)
			? s.bgColor
			: DEFAULT_CAPTION_STYLE.bgColor,
		bgOpacity: isFraction(s.bgOpacity)
			? s.bgOpacity
			: DEFAULT_CAPTION_STYLE.bgOpacity,
		size: isIntIn(s.size, 50, 200)
			? s.size
			: DEFAULT_CAPTION_STYLE.size,
	};
};

/** Per-field fallback to defaults, so absent/partial/invalid stored state needs no migration. */
export const readRadioScannerSettings = (
	data: Record<string, unknown> | undefined,
): RadioScannerSettings => {
	const stored =
		(data?.settings as Partial<RadioScannerSettings> | undefined) ?? {};
	return {
		vizMode: isVizMode(stored.vizMode)
			? stored.vizMode
			: DEFAULT_RADIO_SCANNER_SETTINGS.vizMode,
		useThemeColors:
			typeof stored.useThemeColors === "boolean"
				? stored.useThemeColors
				: DEFAULT_RADIO_SCANNER_SETTINGS.useThemeColors,
		colorBright: isIntIn(stored.colorBright, 0, 0xffffff)
			? stored.colorBright
			: DEFAULT_RADIO_SCANNER_SETTINGS.colorBright,
		colorDim: isIntIn(stored.colorDim, 0, 0xffffff)
			? stored.colorDim
			: DEFAULT_RADIO_SCANNER_SETTINGS.colorDim,
		maxVolume: isIntIn(stored.maxVolume, 0, 100)
			? stored.maxVolume
			: DEFAULT_RADIO_SCANNER_SETTINGS.maxVolume,
		captionStyle: readCaptionStyle(stored.captionStyle),
	};
};

/** The overlay button's cycle order — Bars → Spectrum → Radial → Wave → Bars. */
export const nextVizMode = (mode: VizMode): VizMode =>
	VIZ_MODES[(VIZ_MODES.indexOf(mode) + 1) % VIZ_MODES.length];
