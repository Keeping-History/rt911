import { ClassicyBevelButton, ClassicyButton, ClassicyControlLabel, ClassicyInput, ClassicyWindow } from "classicy";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import "./HyperCardItemPicker.css";

/**
 * Shared reusable picker for HyperCard's six Directus-backed embeds (TV Clip,
 * TV Multiview, News Item, Pager Message, Weather Station, Flight Map) — see
 * issue #560. Modeled on `RadioTraffic/TagPickerWindow.tsx` +
 * `RadioTraffic/tagSearch.ts`: a search box above a filtered, checkable list,
 * Confirm/Cancel buttons, and the pending selection living above the rendered
 * rows (so narrowing the query never silently drops a tick — see
 * `TagPickerForm`'s own comment on this).
 *
 * Unlike the tag picker, the vocabulary here isn't a small fixed list handed
 * in as a prop — each concrete embed's data source differs (a Directus
 * collection, a static JSON file, or the live flight/weather channel), so this
 * component takes a `fetchItems(query, filters)` callback instead and stays
 * agnostic about where rows come from. `renderRow` likewise lets each concrete
 * picker show whatever fields matter for that row (a date, a provider, a
 * callsign) without this component knowing the row shape beyond `id`/`label`.
 */

/** One row in the list: `id` is what gets stored, `label` is the fallback text. */
export interface HyperCardItemPickerRow {
	id: string;
	label: string;
}

/** Free-form extra filter state a concrete picker layers on top of the search box. */
export type HyperCardItemPickerFilters = Record<string, unknown>;

export interface HyperCardItemPickerFormProps<Row extends HyperCardItemPickerRow = HyperCardItemPickerRow> {
	/** Namespaces every control id — lets several pickers exist without DOM id collisions. */
	pickerKey: string;
	title: string;
	selectionMode: "single" | "multi";
	/** Ids already selected when the picker opens. */
	selected: string[];
	initialFilters?: HyperCardItemPickerFilters;
	/**
	 * Resolves the visible rows for the current search text and filter state.
	 * May run a real query (Directus, live channel) or filter an in-memory
	 * list — either a plain array or a promise is accepted.
	 */
	fetchItems: (query: string, filters: HyperCardItemPickerFilters) => Row[] | Promise<Row[]>;
	/** Row content beyond the plain label; defaults to `row.label`. */
	renderRow?: (row: Row) => ReactNode;
	/** Extra filter controls (e.g. a provider pop-up) rendered above the list. */
	renderFilterBar?: (filters: HyperCardItemPickerFilters, setFilters: (patch: HyperCardItemPickerFilters) => void) => ReactNode;
	/** Shown in place of the list when a query/filter combination matches nothing. */
	emptyMessage?: string;
	searchPlaceholder?: string;
	onConfirm: (ids: string[]) => void;
	onCancel: () => void;
}

/**
 * The picker's contents, split from the window shell so behaviour is testable
 * without classicy window chrome (the same split `TagPickerForm`/
 * `TagPickerWindow` use).
 */
export function HyperCardItemPickerForm<Row extends HyperCardItemPickerRow>({
	pickerKey,
	title,
	selectionMode,
	selected,
	initialFilters,
	fetchItems,
	renderRow,
	renderFilterBar,
	emptyMessage,
	searchPlaceholder,
	onConfirm,
	onCancel,
}: HyperCardItemPickerFormProps<Row>) {
	const [query, setQuery] = useState("");
	const [filters, setFiltersState] = useState<HyperCardItemPickerFilters>(() => initialFilters ?? {});
	// Pending ticks live above the rendered rows — narrowing the query/filters
	// unmounts rows, and a tick stored ON a row would go with it.
	const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set(selected));
	const [rows, setRows] = useState<Row[]>([]);
	const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

	// Guards against a stale, slower-to-resolve request overwriting a newer one.
	const requestId = useRef(0);
	useEffect(() => {
		const id = ++requestId.current;
		setStatus("loading");
		Promise.resolve(fetchItems(query, filters))
			.then((result) => {
				if (requestId.current !== id) return;
				setRows(result);
				setStatus("ready");
			})
			.catch(() => {
				if (requestId.current !== id) return;
				setRows([]);
				setStatus("error");
			});
	}, [query, filters, fetchItems]);

	const setFilters = (patch: HyperCardItemPickerFilters) =>
		setFiltersState((prev) => ({ ...prev, ...patch }));

	const toggle = (id: string, on: boolean) =>
		setPending((prev) => {
			if (selectionMode === "single") return on ? new Set([id]) : new Set();
			const next = new Set(prev);
			if (on) next.add(id);
			else next.delete(id);
			return next;
		});

	const inputType = selectionMode === "single" ? "radio" : "checkbox";
	const groupName = `hc_item_picker_${pickerKey}_group`;

	return (
		<div className="classicyHyperCardItemPicker">
			<ClassicyInput
				id={`hc_item_picker_${pickerKey}_search`}
				labelTitle="Search"
				labelPosition="left"
				placeholder={searchPlaceholder ?? "Search"}
				onChangeFunc={(e) => setQuery(e.target.value)}
			/>
			{renderFilterBar?.(filters, setFilters)}
			<div className="classicyHyperCardItemPickerList" role="group" aria-label={title}>
				{status === "loading" && <p className="classicyHyperCardItemPickerStatus">Loading…</p>}
				{status === "error" && (
					<p className="classicyHyperCardItemPickerStatus" role="alert">
						Could not load items.
					</p>
				)}
				{status === "ready" && rows.length === 0 && (
					<p className="classicyHyperCardItemPickerStatus">{emptyMessage ?? "No matches."}</p>
				)}
				{status === "ready" &&
					rows.map((row) => {
						const inputId = `hc_item_picker_${pickerKey}_${row.id}`;
						return (
							<label key={row.id} className="classicyHyperCardItemPickerRow" htmlFor={inputId}>
								<input
									id={inputId}
									type={inputType}
									name={inputType === "radio" ? groupName : undefined}
									checked={pending.has(row.id)}
									onChange={(e) => toggle(row.id, e.target.checked)}
								/>
								<span className="classicyHyperCardItemPickerRowLabel">
									{renderRow ? renderRow(row) : row.label}
								</span>
							</label>
						);
					})}
			</div>
			<div className="classicyHyperCardItemPickerButtons">
				<ClassicyButton onClickFunc={onCancel}>Cancel</ClassicyButton>
				<ClassicyButton isDefault={true} onClickFunc={() => onConfirm([...pending])}>
					Confirm
				</ClassicyButton>
			</div>
		</div>
	);
}

export interface HyperCardItemPickerProps<Row extends HyperCardItemPickerRow = HyperCardItemPickerRow>
	extends HyperCardItemPickerFormProps<Row> {
	appId: string;
	icon?: string;
}

/**
 * The form wrapped in its own modal window — one per concrete picker's Browse
 * button, opened/closed by that picker (see `TVClipPicker.tsx` and friends).
 */
export function HyperCardItemPicker<Row extends HyperCardItemPickerRow>({
	appId,
	icon,
	...form
}: HyperCardItemPickerProps<Row>) {
	return (
		<ClassicyWindow
			id={`${appId}_item_picker_${form.pickerKey}`}
			appId={appId}
			title={form.title}
			icon={icon}
			modal={true}
			closable={true}
			resizable={false}
			zoomable={false}
			collapsable={false}
			scrollable={false}
			initialSize={[320, 0]}
			initialPosition={["center", "center"]}
			// The close box is a way out, not a way to apply — anything else would
			// let the field gain a selection the user never confirmed.
			onCloseFunc={form.onCancel}
		>
			<HyperCardItemPickerForm {...form} />
		</ClassicyWindow>
	);
}

/**
 * Prefix-then-substring ranking over a row's `label`, case-insensitive — same
 * shape as `RadioTraffic/tagSearch.ts`'s `searchTags`, generalized to any row
 * with a `label`. An empty query returns every row unfiltered.
 */
export function filterRowsByQuery<Row extends HyperCardItemPickerRow>(rows: Row[], query: string): Row[] {
	const needle = query.trim().toLowerCase();
	if (needle === "") return rows;
	const prefix: Row[] = [];
	const substring: Row[] = [];
	for (const row of rows) {
		const at = row.label.toLowerCase().indexOf(needle);
		if (at === 0) prefix.push(row);
		else if (at > 0) substring.push(row);
	}
	return prefix.concat(substring);
}

/**
 * Load a full row list once (memoized across calls for the same loader
 * identity) and filter it in-memory per keystroke — the shape
 * `TVClipPicker`/`NewsItemPicker` use for their Directus-backed lists, since
 * each collection is small enough to fetch whole (same reasoning as
 * `tagSearch.ts`'s "build once, filter every keystroke").
 */
export function useCachedListSearch<Row extends HyperCardItemPickerRow>(
	loadAll: () => Promise<Row[]>,
): (query: string) => Promise<Row[]> {
	const cache = useRef<Promise<Row[]> | null>(null);
	// A new `loadAll` identity (e.g. the fetch fn changed in a test) invalidates
	// the cache; the ref keeps the fetch itself to exactly once per identity.
	const loaderRef = useRef(loadAll);
	if (loaderRef.current !== loadAll) {
		loaderRef.current = loadAll;
		cache.current = null;
	}
	return useMemo(
		() => async (query: string) => {
			cache.current ??= loaderRef.current();
			const all = await cache.current;
			return filterRowsByQuery(all, query);
		},
		[loadAll],
	);
}

/**
 * Like {@link useCachedListSearch}, but for a picker whose `renderFilterBar`
 * needs server-shaped rows filtered *before* they're mapped down to
 * `{id, label}` — `PagerMessagePicker`'s provider pop-up is the model case: the
 * full row set is fetched and cached once, `toRows` narrows it by the current
 * filter state and produces the picker rows, and the query still narrows by
 * label on top of that (same ranked prefix/substring match every picker uses).
 */
export function useCachedFilteredListSearch<T, Row extends HyperCardItemPickerRow>(
	loadAll: () => Promise<T[]>,
	toRows: (all: T[], filters: HyperCardItemPickerFilters) => Row[],
): (query: string, filters: HyperCardItemPickerFilters) => Promise<Row[]> {
	const cache = useRef<Promise<T[]> | null>(null);
	const loaderRef = useRef(loadAll);
	if (loaderRef.current !== loadAll) {
		loaderRef.current = loadAll;
		cache.current = null;
	}
	const toRowsRef = useRef(toRows);
	toRowsRef.current = toRows;
	return useMemo(
		() => async (query: string, filters: HyperCardItemPickerFilters) => {
			cache.current ??= loaderRef.current();
			const all = await cache.current;
			return filterRowsByQuery(toRowsRef.current(all, filters), query);
		},
		[loadAll],
	);
}

/**
 * Coerce a HyperCard option field's raw `value` into the id list a picker's
 * `selected` prop expects — an array (the shape every widened field now
 * stores, per issue #560), or a single legacy scalar id for a field that
 * hasn't been re-saved yet. Anything else (undefined/null/an unrelated shape)
 * is "nothing selected".
 */
export function toSelectedIds(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value
			.filter((v): v is string | number => typeof v === "string" || typeof v === "number")
			.map(String);
	}
	if (typeof value === "string" && value !== "") return [value];
	if (typeof value === "number") return [String(value)];
	return [];
}

export interface HyperCardOptionPickerFieldProps<Row extends HyperCardItemPickerRow = HyperCardItemPickerRow> {
	/** The bare-input label this replaces (kind:"picker" fields render only this component). */
	label: string;
	value: unknown;
	onChange: (value: unknown) => void;
	pickerKey: string;
	title: string;
	fetchItems: HyperCardItemPickerFormProps<Row>["fetchItems"];
	renderRow?: HyperCardItemPickerFormProps<Row>["renderRow"];
	renderFilterBar?: HyperCardItemPickerFormProps<Row>["renderFilterBar"];
	initialFilters?: HyperCardItemPickerFormProps<Row>["initialFilters"];
	emptyMessage?: string;
	searchPlaceholder?: string;
	/** Custom "N selected" summary text; defaults to a plain count. */
	summary?: (selected: string[]) => string;
	/**
	 * Overrides how `value` becomes the picker's pending selection; defaults to
	 * {@link toSelectedIds}. Needed by `TVMultiviewPicker`, whose field stores
	 * full video-option objects rather than bare ids — it reads ids out of
	 * those objects here, and does its own id-to-object mapping (preserving
	 * each kept object's other settings) around the `onChange` it passes in.
	 */
	valueToIds?: (value: unknown) => string[];
}

/**
 * The inspector-field half of a `HyperCardOptionPickerComponent`: a summary of
 * the current selection, a Browse button, and the shared picker window,
 * opened/closed locally. Every one of issue #560's six concrete pickers
 * (`TVClipPicker`, `TVMultiviewPicker`, `NewsItemPicker`,
 * `PagerMessagePicker`, `WeatherStationPicker`, `FlightMapPicker`) is this
 * shell plus its own `fetchItems`/filter bar — see those files for the parts
 * that actually differ.
 */
export function HyperCardOptionPickerField<Row extends HyperCardItemPickerRow>({
	label,
	value,
	onChange,
	pickerKey,
	title,
	fetchItems,
	renderRow,
	renderFilterBar,
	initialFilters,
	emptyMessage,
	searchPlaceholder,
	summary,
	valueToIds,
}: HyperCardOptionPickerFieldProps<Row>) {
	const [open, setOpen] = useState(false);
	const selected = (valueToIds ?? toSelectedIds)(value);
	const summaryText = summary
		? summary(selected)
		: selected.length === 0
			? "(none)"
			: `${selected.length} selected`;

	return (
		<>
			<ClassicyControlLabel label={label} />
			<div className="classicyHyperCardItemPickerFieldSummary">{summaryText}</div>
			<ClassicyBevelButton bevelWidth="small" onClickFunc={() => setOpen(true)}>
				Browse…
			</ClassicyBevelButton>
			{open && (
				<HyperCardItemPicker
					appId="HyperCard.app"
					pickerKey={pickerKey}
					title={title}
					selectionMode="multi"
					selected={selected}
					initialFilters={initialFilters}
					fetchItems={fetchItems}
					renderRow={renderRow}
					renderFilterBar={renderFilterBar}
					emptyMessage={emptyMessage}
					searchPlaceholder={searchPlaceholder}
					onConfirm={(ids) => {
						onChange(ids);
						setOpen(false);
					}}
					onCancel={() => setOpen(false)}
				/>
			)}
		</>
	);
}
