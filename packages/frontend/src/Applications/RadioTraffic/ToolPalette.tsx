import type React from "react";
import styles from "./trafficTools.module.scss";
import { type Tool, TOOL_GLYPHS, TOOL_LABELS, TOOLS } from "./toolMode";

interface ToolPaletteProps {
	tool: Tool;
	onSelect: (tool: Tool) => void;
}

/**
 * The four-tool palette. A thin, fully controlled view: it renders the active
 * tool and reports picks, and holds no state of its own — "exactly one tool is
 * active" is then a property of the single `tool` prop rather than something
 * four buttons have to keep agreeing about.
 *
 * A radio group, not four toggles, because that is what modal tools are: one
 * choice out of four, and a screen reader should read it that way.
 *
 * The glyphs are placeholders (see TOOL_GLYPHS) — Robbie replaces the artwork.
 */
export const ToolPalette: React.FC<ToolPaletteProps> = ({ tool, onSelect }) => (
	<div className={styles.rtToolPalette} role="radiogroup" aria-label="Tools">
		{TOOLS.map((t) => (
			<button
				key={t}
				type="button"
				role="radio"
				aria-checked={t === tool}
				aria-label={TOOL_LABELS[t]}
				title={TOOL_LABELS[t]}
				className={t === tool ? `${styles.rtTool} ${styles.rtToolActive}` : styles.rtTool}
				onClick={() => onSelect(t)}
			>
				<span aria-hidden="true">{TOOL_GLYPHS[t]}</span>
			</button>
		))}
	</div>
);
