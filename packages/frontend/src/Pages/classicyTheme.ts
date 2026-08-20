import { getTheme, getThemeVars } from "classicy";
import type { CSSProperties } from "react";

/**
 * Classicy's CSS custom properties, as an inline style object.
 *
 * Why this exists: none of the `--color-theme-*`, `--ui-font`, `--window-*`
 * variables are declared in classicy.css. They are injected at runtime from the
 * active theme by ClassicyAppManagerProvider. The CMS pages surface
 * deliberately does not mount the app manager (see PagesSite.tsx), so without
 * this every `var()` in Classicy's own stylesheet silently falls back and the
 * chrome renders untethered from the theme.
 *
 * Applying the map to the surface's root element gives the real Classicy
 * classes the variables they expect while keeping the surface standalone.
 */

// Classicy's stock theme. getTheme falls back to its built-in default for an
// unknown name, so a rename upstream degrades to "themed, but not this theme"
// rather than to no variables at all.
const THEME_NAME = "Platinum";

export function classicyThemeVars(): CSSProperties {
	return getThemeVars(getTheme(THEME_NAME)) as CSSProperties;
}
