/**
 * The HyperCard inspector's picker for directusVideo's `channelId` field
 * (issue #560) — browse every `tv_channels` row, filter by network, and check
 * off the channel(s) to embed. `channelId` stores an array (see
 * `DirectusVideoPart.tsx`), so this picker always runs in multi-select mode.
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

/** Loads the (small, fetch-whole) `tv_channels` list once and maps/filters it into picker rows. */
function useVideoRows(): [(rows: DirectusVideoListItem[], filters: HyperCardItemPickerFilters) => HyperCardItemPickerRow[], () => Promise<DirectusVideoListItem[]>] {
	const cache = useRef<Promise<DirectusVideoListItem[]> | null>(null);
	const loadAll = useCallback(() => (cache.current ??= fetchDirectusVideoList()), []);
	const toRows = useCallback(
		(rows: DirectusVideoListItem[], filters: HyperCardItemPickerFilters) => applyNetworkFilter(rows, filters).map(toRow),
		[],
	);
	return [toRows, loadAll];
}

export function TVClipPicker({ value, onChange }: { value: unknown; onChange: (value: unknown) => void }) {
	const [toRows, loadAll] = useVideoRows();
	const fetchItems = useCachedFilteredListSearch(loadAll, toRows);

	// Populates the network pop-up; shares `loadAll`'s cached promise, so this
	// doesn't cost a second request beyond the one `fetchItems` triggers.
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
			label="TV Channels"
			value={value}
			onChange={onChange}
			pickerKey="tv_clip"
			title="Choose TV Channels"
			fetchItems={fetchItems}
			initialFilters={{ network: "" }}
			searchPlaceholder="Search channel"
			emptyMessage="No TV channels match."
			renderFilterBar={(filters, setFilters) => (
				<ClassicyPopUpMenu
					id="tv_clip_picker_network"
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
