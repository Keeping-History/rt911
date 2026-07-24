import { ClassicyButton, ClassicyPopUpMenu, ClassicySpinner } from "classicy";
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
	mode,
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
		<div className={styles.dialog} data-mode={mode}>
			<label className={styles.dialogField}>
				Title
				<input
					aria-label="Title"
					type="text"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					className={styles.timeInput}
					style={{ width: "100%" }}
				/>
			</label>
			<label className={styles.dialogField}>
				Category
				<input
					aria-label="Category"
					type="text"
					value={category}
					placeholder="General"
					onChange={(e) => setCategory(e.target.value)}
					className={styles.timeInput}
					style={{ width: "100%" }}
				/>
			</label>
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
				<ClassicyButton isDefault={true} disabled={!canSave} onClickFunc={handleSave}>
					Save
				</ClassicyButton>
			</div>
		</div>
	);
};
