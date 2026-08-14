import {
	ClassicyBalloonHelp,
	ClassicyCheckbox,
	ClassicyInput,
	ClassicyPopUpMenu,
} from "classicy";
import { useState } from "react";
import { defaultValueFor, type SettingsField, settingsFieldsOf } from "./settingsRegistry";

/**
 * Raw-JSON editor for one complex field (array/record/object/union). Same
 * parse-on-blur contract the old whole-entry Values textarea had: invalid
 * JSON is flagged and NOT applied, so a half-typed value can never reach the
 * playlist definition.
 */
function JsonField({
	id,
	value,
	onChange,
}: {
	id: string;
	value: unknown;
	onChange: (v: unknown) => void;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	const [error, setError] = useState(false);
	return (
		<>
			<textarea
				aria-label={`${id} value`}
				defaultValue={JSON.stringify(value, null, 2)}
				onChange={(ev) => setDraft(ev.target.value)}
				onBlur={() => {
					if (draft === null) return;
					try {
						onChange(JSON.parse(draft));
						setError(false);
					} catch {
						setError(true);
					}
				}}
			/>
			{error && <p className="entryFormError">Invalid JSON — not applied.</p>}
		</>
	);
}

function FieldControl({
	field,
	inputId,
	value,
	onChange,
}: {
	field: SettingsField;
	inputId: string;
	value: unknown;
	onChange: (v: unknown) => void;
}) {
	switch (field.control) {
		case "boolean":
			return (
				<ClassicyCheckbox
					id={`${inputId}-value`}
					label="on"
					checked={value === true}
					onClickFunc={(checked) => onChange(checked)}
				/>
			);
		case "number":
			return (
				<ClassicyInput
					id={`${inputId}-value`}
					type="number"
					prefillValue={String(value ?? "")}
					onChangeFunc={(ev) => {
						const n = Number(ev.target.value);
						if (Number.isFinite(n)) onChange(n);
					}}
				/>
			);
		case "string":
			return (
				<ClassicyInput
					id={`${inputId}-value`}
					prefillValue={String(value ?? "")}
					onChangeFunc={(ev) => onChange(ev.target.value)}
				/>
			);
		case "enum":
			return (
				<ClassicyPopUpMenu
					id={`${inputId}-value`}
					options={field.options.map((o) => ({ value: o, label: o }))}
					selected={String(value ?? "")}
					onChangeFunc={(ev) => onChange(ev.target.value)}
				/>
			);
		case "json":
			return <JsonField id={inputId} value={value} onChange={onChange} />;
	}
}

/**
 * The schema-driven half of a settings entry: one row per top-level field of
 * the target app's registered state schema (settingsRegistry). A row's
 * checkbox is INCLUSION — whether the playlist forces that key at all — since
 * `values` merges shallowly into the app's data and an absent key leaves the
 * student's own value alone. The control beside it edits the forced value and
 * only renders while the key is included.
 */
export function AppSettingsFields({
	appId,
	values,
	onChange,
}: {
	appId: string;
	values: Record<string, unknown>;
	onChange: (values: Record<string, unknown>) => void;
}) {
	const fields = settingsFieldsOf(appId);
	if (fields.length === 0) {
		return <p>This app declares no settings.</p>;
	}

	const setKey = (key: string, v: unknown) => onChange({ ...values, [key]: v });
	const removeKey = (key: string) => {
		const next = { ...values };
		delete next[key];
		onChange(next);
	};

	return (
		<div className="appSettingsFields">
			{fields.map((f) => {
				const included = f.key in values;
				const inputId = `setting-${appId}-${f.key}`;
				const checkbox = (
					<ClassicyCheckbox
						id={inputId}
						label={f.key}
						checked={included}
						onClickFunc={(checked) =>
							checked ? setKey(f.key, defaultValueFor(f)) : removeKey(f.key)
						}
					/>
				);
				return (
					<div key={f.key} className="appSettingsField">
						{f.description ? (
							<ClassicyBalloonHelp title={f.key} content={f.description}>
								{checkbox}
							</ClassicyBalloonHelp>
						) : (
							checkbox
						)}
						{included && (
							<FieldControl
								field={f}
								inputId={inputId}
								value={values[f.key]}
								onChange={(v) => setKey(f.key, v)}
							/>
						)}
					</div>
				);
			})}
		</div>
	);
}
