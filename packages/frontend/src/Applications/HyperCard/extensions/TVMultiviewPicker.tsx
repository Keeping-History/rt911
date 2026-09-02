/**
 * The HyperCard inspector's picker for directusMultiview's `videos` field
 * (issue #560) — same `tv_channels` browse/filter as `TVClipPicker`, but the
 * field stores an array of full video-option objects (`{ channelId, ... }`,
 * see `DirectusMultiviewPart.tsx`) rather than bare ids, so this picker
 * supplies `valueToIds`/`idsToValue` adapters instead of using
 * `HyperCardOptionPickerField`'s default array-of-ids behaviour. Selecting
 * channels here only ever sets `channelId` on each tile; per-tile settings
 * (`start`, `end`, `autoPlay`, …) are still hand-authored in the part's own
 * JSON, same as today.
 */
import { ClassicyPopUpMenu } from "classicy";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchDirectusVideoList, type DirectusVideoListItem } from "./directusCollections";
import {
	HyperCardOptionPickerField,
	type HyperCardItemPickerFilters,
	type HyperCardItemPickerRow,
	useCachedFilteredListSearch,
} from "./HyperCardItemPicker";

function toRow(item: DirectusVideoListItem): HyperCardItemPickerRow {
	return { id: String(item.id), label: item.full_title || item.title };
}

function applyNetworkFilter(rows: DirectusVideoListItem[], filters: HyperCardItemPickerFilters): DirectusVideoListItem[] {
	const network = typeof filters.network === "string" ? filters.network : "";
	return network ? rows.filter((r) => r.source === network) : rows;
}

/** A `videos` array entry's `channelId`, as a string, or undefined if it's not a recognizable video-option object. */
function channelIdOf(entry: unknown): string | undefined {
	if (entry && typeof entry === "object" && "channelId" in entry) {
		const id = (entry as { channelId: unknown }).channelId;
		if (typeof id === "string" || typeof id === "number") return String(id);
	}
	return undefined;
}

export function TVMultiviewPicker({ value, onChange }: { value: unknown; onChange: (value: unknown) => void }) {
	// Confirm hands back a bare id list; map it back to full video-option
	// objects, preserving each *kept* channel's other settings (start/end/
	// autoPlay/…) rather than clobbering them with a bare `{ channelId }`.
	const handleConfirm = useCallback(
		(next: unknown) => {
			const ids = Array.isArray(next) ? next.filter((id): id is string => typeof id === "string") : [];
			const previousById = new Map<string, unknown>();
			if (Array.isArray(value)) {
				for (const entry of value) {
					const id = channelIdOf(entry);
					if (id !== undefined) previousById.set(id, entry);
				}
			}
			onChange(ids.map((id) => previousById.get(id) ?? { channelId: id }));
		},
		[value, onChange],
	);

	const cache = useRef<Promise<DirectusVideoListItem[]> | null>(null);
	const loadAll = useCallback(() => (cache.current ??= fetchDirectusVideoList()), []);
	const toRows = useCallback(
		(rows: DirectusVideoListItem[], filters: HyperCardItemPickerFilters) => applyNetworkFilter(rows, filters).map(toRow),
		[],
	);
	const fetchItems = useCachedFilteredListSearch(loadAll, toRows);

	const [networks, setNetworks] = useState<string[]>([]);
	useEffect(() => {
		let cancelled = false;
		loadAll().then((rows) => {
			if (cancelled) return;
			setNetworks([...new Set(rows.map((r) => r.source).filter((s): s is string => !!s))].sort());
		});
		return () => {
			cancelled = true;
		};
	}, [loadAll]);

	return (
		<HyperCardOptionPickerField
			label="Videos"
			value={value}
			onChange={handleConfirm}
			pickerKey="tv_multiview_videos"
			title="Choose TV Channels"
			fetchItems={fetchItems}
			initialFilters={{ network: "" }}
			searchPlaceholder="Search channel"
			emptyMessage="No TV channels match."
			valueToIds={(v) => (Array.isArray(v) ? v.map(channelIdOf).filter((id): id is string => id !== undefined) : [])}
			renderFilterBar={(filters, setFilters) => (
				<ClassicyPopUpMenu
					id="tv_multiview_picker_network"
					label="Network"
					labelPosition="left"
					size="mini"
					placeholder="All networks"
					options={[{ value: "", label: "All networks" }, ...networks.map((n) => ({ value: n, label: n }))]}
					selected={typeof filters.network === "string" ? filters.network : ""}
					onChangeFunc={(e) => setFilters({ network: e.target.value })}
				/>
			)}
		/>
	);
}
