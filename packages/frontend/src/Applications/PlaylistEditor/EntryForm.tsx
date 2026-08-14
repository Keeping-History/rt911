import { ClassicyDatePicker, ClassicyPopUpMenu, ClassicyTimePicker } from "classicy";
import type { PlaylistEntry } from "../../Providers/Playlist/playlistTypes";
import { AppSettingsFields } from "./AppSettingsFields";
import {
	displayWallClockToUtcIso,
	type EditorEntry,
	utcIsoToDisplayWallClock,
} from "./editorState";
import { listSettingsApps } from "./settingsRegistry";

const TIMELINE_MIN = new Date(2001, 8, 9); // Sept 9 2001 (display wall clock)
const TIMELINE_MAX = new Date(2001, 8, 18, 23, 59, 59);
// Seed for pickers when there's no value yet: Sept 11 2001, 08:40 (display wall clock).
const DEFAULT_WALL_CLOCK = new Date(2001, 8, 11, 8, 40);
const KNOWN_APP_IDS = [
	"TimeMachine.app", "TV.app", "RadioScanner.app", "News.app",
	"FlightTracker.app", "Browser.app", "PDFViewer.app", "Weather.app",
];

function DateTimeField({
	label, value, optional, onChange,
}: {
	label: string;
	value: string | undefined;
	optional?: boolean; // renders the "unbounded" checkbox
	onChange: (iso: string | undefined) => void;
}) {
	const wall = value ? utcIsoToDisplayWallClock(value) : null;
	const seed = wall ?? DEFAULT_WALL_CLOCK;
	const setFrom = (d: Date) => onChange(displayWallClockToUtcIso(d));
	// Required fields always render pickers (there's no way to leave them unset);
	// optional fields hide the pickers while the "unbounded" checkbox is checked.
	const showPickers = optional ? value !== undefined : true;
	return (
		<fieldset className="entryFormField">
			<legend>{label}</legend>
			{optional && (
				<label>
					<input
						type="checkbox"
						checked={value === undefined}
						onChange={(e) =>
							onChange(e.target.checked ? undefined : displayWallClockToUtcIso(DEFAULT_WALL_CLOCK))
						}
					/>
					unbounded
				</label>
			)}
			{showPickers && (
				<>
					<ClassicyDatePicker
						id={`${label}-date`}
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
						id={`${label}-time`}
						prefillValue={seed}
						onChangeFunc={(d) => {
							const merged = wall ? new Date(wall) : new Date(seed);
							merged.setHours(d.getHours(), d.getMinutes(), d.getSeconds());
							setFrom(merged);
						}}
					/>
				</>
			)}
		</fieldset>
	);
}

export function EntryForm({
	value,
	onChange,
}: {
	value: EditorEntry;
	onChange: (entry: PlaylistEntry) => void;
}) {
	const e = value.entry;

	switch (e.kind) {
		case "media":
			return (
				<div className="entryForm">
					<p>{`${e.app.toUpperCase()} · ${e.itemId}`}</p>
					<DateTimeField label="Start" optional value={e.start} onChange={(start) => onChange({ ...e, start })} />
					<DateTimeField label="End" optional value={e.end} onChange={(end) => onChange({ ...e, end })} />
					<label>
						Focus
						<select
							aria-label="Focus"
							value={e.focus ?? "none"}
							onChange={(ev) =>
								onChange({ ...e, focus: ev.target.value === "none" ? undefined : (ev.target.value as "once" | "locked") })
							}
						>
							<option value="none">None</option>
							<option value="once">Once</option>
							<option value="locked">Locked</option>
						</select>
					</label>
				</div>
			);
		case "app":
			return (
				<div className="entryForm">
					<label>
						App
						<select aria-label="App" value={e.appId} onChange={(ev) => onChange({ ...e, appId: ev.target.value })}>
							{KNOWN_APP_IDS.map((id) => <option key={id} value={id}>{id}</option>)}
						</select>
					</label>
					<p>This app will be disabled for the whole session.</p>
				</div>
			);
		case "settings":
			return (
				<div className="entryForm">
					<ClassicyPopUpMenu
						id="entry-settings-app"
						label="App"
						labelPosition="left"
						// Every registered app with a state schema, not a hardcoded
						// list — see settingsRegistry.ts.
						options={listSettingsApps().map((a) => ({ value: a.appId, label: a.name }))}
						selected={e.appId}
						// Switching apps drops the old values: their keys belong to
						// the previous app's schema and would merge as junk.
						onChangeFunc={(ev) => onChange({ ...e, appId: ev.target.value, values: {} })}
					/>
					<AppSettingsFields
						// Remount on app switch so per-field draft state (JSON
						// textareas) can't survive into another app's fields.
						key={e.appId}
						appId={e.appId}
						values={e.values}
						onChange={(values) => onChange({ ...e, values })}
					/>
					<label>
						<input type="checkbox" checked={e.locked ?? false}
							onChange={(ev) => onChange({ ...e, locked: ev.target.checked || undefined })} />
						Locked (revert student changes)
					</label>
				</div>
			);
		case "file":
			return (
				<div className="entryForm">
					<p>{e.path}</p>
					<DateTimeField label="Open at" value={e.at || undefined} onChange={(at) => onChange({ ...e, at: at ?? "" })} />
				</div>
			);
		case "jump":
			return (
				<div className="entryForm">
					<DateTimeField label="When clock reaches" value={e.at || undefined} onChange={(at) => onChange({ ...e, at: at ?? "" })} />
					<DateTimeField label="Jump to" value={e.to || undefined} onChange={(to) => onChange({ ...e, to: to ?? "" })} />
				</div>
			);
		case "browser":
			return (
				<div className="entryForm">
					<label>
						URL
						<input aria-label="URL" type="text" value={e.url} onChange={(ev) => onChange({ ...e, url: ev.target.value })} />
					</label>
					<DateTimeField label="Open at" value={e.at || undefined} onChange={(at) => onChange({ ...e, at: at ?? "" })} />
					<DateTimeField label="Close at" optional value={e.closeAt} onChange={(closeAt) => onChange({ ...e, closeAt })} />
				</div>
			);
	}
}
