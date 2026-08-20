/**
 * The HyperCard inspector's picker for directusAudio's itemId field — browse
 * the Radio Traffic tag tree (radio-core/radioTrafficVolume) and fill itemId
 * with the chosen clip's numeric id, rather than typing it blind.
 */
import { ClassicyBevelButton, ClassicyControlLabel, ClassicyFileOpenDialog, ClassicyInput } from "classicy";
import { useState } from "react";
import { buildRadioTrafficVolume } from "../../radio-core/radioTrafficVolume";

export const RadioTrafficClipPicker = ({
	value,
	onChange,
}: {
	value: unknown;
	onChange: (value: unknown) => void;
}) => {
	const [open, setOpen] = useState(false);
	// `== null` intentionally catches both `null` and `undefined` in one check
	// — Directus fields can be null, and `value`'s type is `unknown` — this is
	// the one place in this file where loose equality reads clearer than
	// `=== undefined || === null`.
	const displayValue = value == null || value === "" ? "" : String(value);
	// Uncontrolled input, committed on blur/Enter, matching the CommitField
	// idiom classicy's own HyperCardInspector uses for every other inspector
	// field (CommitField isn't exported, so the idiom is reimplemented here).
	let latest = displayValue;
	const commitIfChanged = () => {
		if (latest !== displayValue) onChange(latest);
	};
	return (
		<>
			{/* classicy's "picker" field-kind renders only this component, with no
			    surrounding label — every other field kind gets one, so this one
			    supplies its own. */}
			<ClassicyControlLabel label="Clip" />
			<div onBlur={commitIfChanged} onKeyDown={(e) => e.key === "Enter" && commitIfChanged()}>
				<ClassicyInput
					id="radio_traffic_clip_picker_value"
					placeholder="(none)"
					prefillValue={displayValue}
					onChangeFunc={(e) => {
						latest = e.target.value;
					}}
				/>
			</div>
			<ClassicyBevelButton bevelWidth="small" onClickFunc={() => setOpen(true)}>
				Browse…
			</ClassicyBevelButton>
			<ClassicyFileOpenDialog
				id="radio_traffic_clip_picker"
				appId="HyperCard.app"
				open={open}
				title="Choose a Radio Traffic Clip"
				volumes={[buildRadioTrafficVolume()]}
				selectionMode="single"
				onOpenFunc={(selections) => {
					const itemId = selections[0]?.entry.meta?.itemId;
					if (itemId !== undefined) onChange(String(itemId));
					setOpen(false);
				}}
				onCancelFunc={() => setOpen(false)}
			/>
		</>
	);
};
