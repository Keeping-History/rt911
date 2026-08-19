import { ClassicyBalloonHelp } from "classicy";
import type React from "react";
import styles from "./trafficTools.module.scss";
import { type Tool, TOOL_BALLOONS, TOOL_GLYPHS, TOOL_LABELS, TOOLS } from "./toolMode";

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
 * Which is exactly why the balloons matter here more than on a labelled
 * control: a glyph the listener cannot read is the whole of the button, and
 * picking the wrong tool in a modal app silently changes what every card click
 * means. `ClassicyBalloonHelp` rather than `useClassicyBalloonHelp`: its anchor
 * <div> sits between the radiogroup and the radios, which the palette's flex
 * row and every `role="radio"` query are indifferent to — the reason
 * TV/ThumbnailTile.tsx needs the hook (drop targets resolved by walking direct
 * children) has no counterpart here.
 */
export const ToolPalette: React.FC<ToolPaletteProps> = ({ tool, onSelect }) => (
	<div className={styles.rtToolPalette} role="radiogroup" aria-label="Tools">
		{TOOLS.map((t) => (
			<ClassicyBalloonHelp key={t} title={TOOL_LABELS[t]} content={TOOL_BALLOONS[t]}>
				<button
					type="button"
					role="radio"
					aria-checked={t === tool}
					aria-label={TOOL_LABELS[t]}
					title={TOOL_LABELS[t]}
					className={
						t === tool ? `${styles.rtTool} ${styles.rtToolActive}` : styles.rtTool
					}
					onClick={() => onSelect(t)}
				>
					<span aria-hidden="true">{TOOL_GLYPHS[t]}</span>
				</button>
			</ClassicyBalloonHelp>
		))}
	</div>
);
