import { ClassicyBalloonHelp, ClassicyBevelButton } from "classicy";
import type React from "react";
import styles from "./trafficTools.module.scss";
import { type Tool, TOOL_BALLOONS, TOOL_ICONS, TOOL_LABELS, TOOLS } from "./toolMode";

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
 * Each tool's icon is a PNG (see TOOL_ICONS). The balloons still matter here
 * more than on a labelled control: an icon the listener cannot read is the
 * whole of the button, and picking the wrong tool in a modal app silently
 * changes what every card click means. `ClassicyBalloonHelp` rather than
 * `useClassicyBalloonHelp`: its anchor
 * <div> sits between the radiogroup and the radios, which the palette's flex
 * row and every `role="radio"` query are indifferent to — the reason
 * TV/ThumbnailTile.tsx needs the hook (drop targets resolved by walking direct
 * children) has no counterpart here.
 *
 * Each tool is a `ClassicyBevelButton` in `radio` mode rather than a bare
 * `<button role="radio">`: the mode is what gives it `role="radio"` and
 * `aria-checked` for free (both hardcoded off `mode`, so nothing here has to
 * compute them), and `square` is the icon-only sizing instead of the hand-rolled
 * width/height trafficTools.module.scss used to carry.
 */
export const ToolPalette: React.FC<ToolPaletteProps> = ({ tool, onSelect }) => (
	<div className={styles.rtToolPalette} role="radiogroup" aria-label="Tools">
		{TOOLS.map((t) => (
			<ClassicyBalloonHelp key={t} title={TOOL_LABELS[t]} content={TOOL_BALLOONS[t]}>
				<ClassicyBevelButton
					mode="radio"
					square
					bevelWidth="small"
					aria-label={TOOL_LABELS[t]}
					title={TOOL_LABELS[t]}
					on={t === tool}
					// Fired on every click, including the already-active tool's own —
					// `onChangeFunc` would stay silent there (radio mode no-ops a
					// click that does not change the on-state), and the palette
					// reports every pick regardless.
					onClickFunc={() => onSelect(t)}
				>
					<img className={styles.rtToolIcon} src={TOOL_ICONS[t]} alt="" />
				</ClassicyBevelButton>
			</ClassicyBalloonHelp>
		))}
	</div>
);
