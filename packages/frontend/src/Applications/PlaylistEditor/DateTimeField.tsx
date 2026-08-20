import {
	ClassicyCheckbox,
	ClassicyControlGroup,
	ClassicyDatePicker,
	ClassicyTimePicker,
} from "classicy";
import { displayWallClockToUtcIso, utcIsoToDisplayWallClock } from "./editorState";

const TIMELINE_MIN = new Date(2001, 8, 9); // Sept 9 2001 (display wall clock)
const TIMELINE_MAX = new Date(2001, 8, 18, 23, 59, 59);
// Seed for pickers when there's no value yet: Sept 11 2001, 08:40 (display wall clock).
const DEFAULT_WALL_CLOCK = new Date(2001, 8, 11, 8, 40);

/**
 * One date+time control bound to a virtual-clock UTC ISO string. Shared by
 * EntryForm (per-entry windows/triggers) and PlaylistWindowDialog (the
 * playlist-level window).
 */
export function DateTimeField({
	label, value, optional, onChange, idPrefix,
}: {
	label: string;
	value: string | undefined;
	optional?: boolean; // renders the "unbounded" checkbox
	onChange: (iso: string | undefined) => void;
	/** DOM-id base for the pickers; defaults to the label. Pass a distinct one
	 * when two forms using the same labels can be mounted at once. */
	idPrefix?: string;
}) {
	const idBase = idPrefix ?? label;
	const wall = value ? utcIsoToDisplayWallClock(value) : null;
	const seed = wall ?? DEFAULT_WALL_CLOCK;
	const setFrom = (d: Date) => onChange(displayWallClockToUtcIso(d));
	// Required fields always render pickers (there's no way to leave them unset);
	// optional fields hide the pickers while the "unbounded" checkbox is checked.
	const showPickers = optional ? value !== undefined : true;
	return (
		<ClassicyControlGroup label={label}>
			{optional && (
				<ClassicyCheckbox
					id={`${idBase}-unbounded`}
					label="Not Time Bound"
					checked={value === undefined}
					onClickFunc={(checked) =>
						onChange(checked ? undefined : displayWallClockToUtcIso(DEFAULT_WALL_CLOCK))
					}
				/>
			)}
			{showPickers && (
				<>
					<ClassicyDatePicker
						id={`${idBase}-date`}
						prefillValue={seed}
						minValue={TIMELINE_MIN}
						maxValue={TIMELINE_MAX}
						onChangeFunc={(d) => {
							const merged = new Date(d);
							if (wall) merged.setHours(wall.getHours(), wall.getMinutes(), wall.getSeconds());
							setFrom(merged);
						}}
					/>
					<ClassicyTimePicker
						id={`${idBase}-time`}
						prefillValue={seed}
						onChangeFunc={(d) => {
							const merged = wall ? new Date(wall) : new Date(seed);
							merged.setHours(d.getHours(), d.getMinutes(), d.getSeconds());
							setFrom(merged);
						}}
					/>
				</>
			)}
		</ClassicyControlGroup>
	);
}
