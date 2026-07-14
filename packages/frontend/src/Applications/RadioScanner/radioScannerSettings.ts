import type { ActionMessage } from "classicy";

export const VIZ_MODES = ["Bars", "Spectrum", "Radial", "Wave"] as const;
export type VizMode = (typeof VIZ_MODES)[number];

export const isVizMode = (v: unknown): v is VizMode =>
	typeof v === "string" && (VIZ_MODES as readonly string[]).includes(v);

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
}

export const DEFAULT_RADIO_SCANNER_SETTINGS: RadioScannerSettings = {
	vizMode: "Wave",
	useThemeColors: true,
	colorBright: 0x00d25a, // the pre-theme hardcoded bright green
	colorDim: 0x00b446, // the pre-theme hardcoded dim green
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
const isColorInt = (v: unknown): v is number =>
	typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffffff;

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
		colorBright: isColorInt(stored.colorBright)
			? stored.colorBright
			: DEFAULT_RADIO_SCANNER_SETTINGS.colorBright,
		colorDim: isColorInt(stored.colorDim)
			? stored.colorDim
			: DEFAULT_RADIO_SCANNER_SETTINGS.colorDim,
	};
};

/** The overlay button's cycle order — Bars → Spectrum → Radial → Wave → Bars. */
export const nextVizMode = (mode: VizMode): VizMode =>
	VIZ_MODES[(VIZ_MODES.indexOf(mode) + 1) % VIZ_MODES.length];
