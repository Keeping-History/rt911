import {
	ClassicyButton,
	ClassicyForm,
	ClassicyInput,
	ClassicyPopUpMenu,
	ClassicySpinner,
} from "classicy";
import type React from "react";
import { useMemo, useState } from "react";
import type { PersonalBookmarkInput } from "./bookmarksApi";
import {
	type LocalTimeParts,
	localPartsToUtcDate,
	parseDirectusUtc,
	toDirectusUtcString,
	utcToLocalParts,
} from "./bookmarkTime";
import styles from "./TimeMachine.module.scss";

export interface BookmarkDialogFormProps {
	mode: "create" | "edit";
	initial: { title: string; category: string; startDateUtc: string };
	tzOffset: number;
	saving?: boolean;
	onSave: (input: PersonalBookmarkInput) => void;
	onCancel: () => void;
}

export const BookmarkDialogForm: React.FC<BookmarkDialogFormProps> = ({
	initial,
	tzOffset,
	saving = false,
	onSave,
	onCancel,
}) => {
	const baseDate = useMemo(() => parseDirectusUtc(initial.startDateUtc), [initial.startDateUtc]);
	const [title, setTitle] = useState(initial.title);
	const [category, setCategory] = useState(initial.category);
	const [parts, setParts] = useState<LocalTimeParts>(() => utcToLocalParts(baseDate, tzOffset));

	const canSave = title.trim().length > 0 && !saving;

	const handleSave = () => {
		if (!canSave) return;
		const start = localPartsToUtcDate(baseDate, parts, tzOffset);
		onSave({
			title: title.trim(),
			category: category.trim() || "General",
			start_date: toDirectusUtcString(start),
		});
	};

	return (
		// The module's .dialog class keeps its layout; the form wrapper adds
		// submit semantics so Enter in the title field saves.
		<ClassicyForm className={styles.dialog} onSubmitFunc={handleSave}>
			<div className={styles.dialogField}>
				<ClassicyInput
					id="bookmark-dialog-title"
					labelTitle="Title"
					prefillValue={title}
					onChangeFunc={(e) => setTitle(e.target.value)}
				/>
			</div>
			<div className={styles.dialogField}>
				<ClassicyInput
					id="bookmark-dialog-category"
					labelTitle="Category"
					placeholder="General"
					prefillValue={category}
					onChangeFunc={(e) => setCategory(e.target.value)}
				/>
			</div>
			<div className={styles.dialogTime}>
				<ClassicySpinner
					id="bookmark-dialog-h"
					labelTitle="H"
					labelPosition="left"
					labelSize="medium"
					placeholder={parseInt(parts.hours, 10)}
					prefillValue={parseInt(parts.hours, 10)}
					onChangeFunc={(e) => setParts((p) => ({ ...p, hours: e.target.value }))}
					maxValue={12}
					minValue={1}
				/>
				<ClassicySpinner
					id="bookmark-dialog-m"
					labelTitle="M"
					labelPosition="left"
					labelSize="medium"
					placeholder={parseInt(parts.minutes, 10)}
					prefillValue={parseInt(parts.minutes, 10)}
					onChangeFunc={(e) => setParts((p) => ({ ...p, minutes: e.target.value }))}
					maxValue={59}
					minValue={0}
				/>
				<ClassicySpinner
					id="bookmark-dialog-s"
					labelTitle="S"
					labelPosition="left"
					labelSize="medium"
					placeholder={parseInt(parts.seconds, 10)}
					prefillValue={parseInt(parts.seconds, 10)}
					onChangeFunc={(e) => setParts((p) => ({ ...p, seconds: e.target.value }))}
					maxValue={59}
					minValue={0}
				/>
				<ClassicyPopUpMenu
					id="bookmark-dialog-ampm"
					size="small"
					options={[
						{ value: "AM", label: "AM" },
						{ value: "PM", label: "PM" },
					]}
					selected={parts.ampm}
					onChangeFunc={(e) => setParts((p) => ({ ...p, ampm: e.target.value }))}
				/>
			</div>
			<div className={styles.settingsButtons}>
				<ClassicyButton onClickFunc={onCancel}>Cancel</ClassicyButton>
				<ClassicyButton isDefault={true} buttonType="submit" disabled={!canSave}>
					Save
				</ClassicyButton>
			</div>
		</ClassicyForm>
	);
};
