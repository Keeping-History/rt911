/**
 * The HyperCard inspector's picker for directusAudio's itemId field — browse
 * the Radio Traffic tag tree (radio-core/radioTrafficVolume) and fill itemId
 * with the chosen clip's numeric id, rather than typing it blind.
 */
import { ClassicyBevelButton, ClassicyFileOpenDialog } from "classicy";
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
	return (
		<>
			<span>{value === undefined || value === "" ? "(none)" : String(value)}</span>
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
