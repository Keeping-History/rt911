import { ClassicyButton, ClassicyCheckbox, ClassicyInput, ClassicyWindow } from "classicy";
import { useMemo, useState } from "react";
import type { TagDef } from "../../Providers/MediaStream/MediaStreamContext";
import styles from "./tagPicker.module.scss";
import { buildSearchIndex, searchTags } from "./tagSearch";

export interface TagPickerProps {
	/** The namespace this picker owns, e.g. "aircraft". Scopes ids and the window. */
	namespace: string;
	/** That namespace's display label, e.g. "Aircraft". */
	label: string;
	/** Every value in the namespace, in the order the server sent them. */
	values: TagDef[];
	/**
	 * The **whole** sidebar's checked set, not just this namespace's slice. The
	 * picker can only ever tick or untick a box it renders, so handing it the
	 * full set lets `onConfirm` hand back a set the caller can use as-is —
	 * there is no merge for the caller to get wrong.
	 */
	checked: ReadonlySet<string>;
	/** The full checked set as it stands after Confirm. */
	onConfirm: (checked: ReadonlySet<string>) => void;
	/** Dismissed without applying; the caller closes the window. */
	onCancel: () => void;
}

/**
 * The picker's contents, split from the window shell (the same shape as
 * PlaylistEditor's RenameDialog) so the behaviour is testable without classicy
 * window chrome.
 *
 * Pending ticks live here, above the filtered list, which is the whole point:
 * narrowing the query unmounts rows, and a tick stored in a row would go with
 * it. Confirm reports the pending set; Cancel reports nothing, so the state
 * dies with the window.
 */
export function TagPickerForm({
	namespace,
	label,
	values,
	checked,
	onConfirm,
	onCancel,
}: TagPickerProps) {
	const [query, setQuery] = useState("");
	const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set(checked));

	// Built once per vocabulary, filtered once per keystroke — see tagSearch.
	const index = useMemo(() => buildSearchIndex(values), [values]);
	const visible = useMemo(() => searchTags(index, query), [index, query]);

	const toggle = (tag: string, on: boolean) =>
		setPending((prev) => {
			const next = new Set(prev);
			if (on) next.add(tag);
			else next.delete(tag);
			return next;
		});

	return (
		<div className={styles.rtTagPicker}>
			<ClassicyInput
				id={`rt_tag_picker_${namespace}_search`}
				labelTitle="Search"
				labelPosition="left"
				placeholder={label}
				onChangeFunc={(e) => setQuery(e.target.value)}
			/>
			<div className={styles.rtTagPickerList} role="group" aria-label={label}>
				{visible.length === 0 ? (
					<p className={styles.rtTagPickerEmpty}>No matches.</p>
				) : (
					visible.map((tag) => (
						<ClassicyCheckbox
							key={tag.tag}
							// Namespaced: two pickers can be open at once, and a bare
							// value would let one window's label address the other's box.
							id={`rt_tag_picker_${namespace}_${tag.tag}`}
							label={tag.value ?? tag.tag}
							checked={pending.has(tag.tag)}
							onClickFunc={(on: boolean) => toggle(tag.tag, on)}
						/>
					))
				)}
			</div>
			<div className={styles.rtTagPickerButtons}>
				<ClassicyButton onClickFunc={onCancel}>Cancel</ClassicyButton>
				<ClassicyButton isDefault={true} onClickFunc={() => onConfirm(pending)}>
					Confirm
				</ClassicyButton>
			</div>
		</div>
	);
}

/**
 * A large namespace's values as a searchable multi-select window, opened from
 * the sidebar row for that namespace. One window per namespace, so several can
 * be open at once without colliding in the window store.
 */
export function TagPickerWindow({
	appId,
	icon,
	...form
}: TagPickerProps & { appId: string; icon?: string }) {
	return (
		<ClassicyWindow
			id={`${appId}_tag_picker_${form.namespace}`}
			appId={appId}
			title={form.label}
			icon={icon}
			modal={true}
			closable={true}
			resizable={false}
			zoomable={false}
			collapsable={false}
			scrollable={false}
			initialSize={[280, 0]}
			initialPosition={["center", "center"]}
			// The close box is a way out, not a way to apply — anything else would
			// let the sidebar gain a filter the user never confirmed.
			onCloseFunc={form.onCancel}
		>
			<TagPickerForm {...form} />
		</ClassicyWindow>
	);
}
