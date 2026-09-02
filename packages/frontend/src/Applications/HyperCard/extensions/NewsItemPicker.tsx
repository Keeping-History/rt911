/**
 * The HyperCard inspector's picker for directusNews's `itemId` field (issue
 * #560) — browse every `news_items` row and check off the article(s) to
 * embed. `itemId` stores an array (see `DirectusNewsPart.tsx`), so this
 * picker always runs in multi-select mode.
 */
import { useCallback } from "react";
import { fetchDirectusNewsList, type DirectusNewsListItem } from "./directusCollections";
import { HyperCardOptionPickerField, type HyperCardItemPickerRow, useCachedListSearch } from "./HyperCardItemPicker";

function toRow(item: DirectusNewsListItem): HyperCardItemPickerRow {
	return { id: String(item.id), label: item.full_title || item.title };
}

export function NewsItemPicker({ value, onChange }: { value: unknown; onChange: (value: unknown) => void }) {
	const loadAll = useCallback(async () => (await fetchDirectusNewsList()).map(toRow), []);
	const fetchItems = useCachedListSearch(loadAll);

	return (
		<HyperCardOptionPickerField
			label="News Items"
			value={value}
			onChange={onChange}
			pickerKey="news_item"
			title="Choose News Items"
			fetchItems={fetchItems}
			searchPlaceholder="Search headline"
			emptyMessage="No news items match."
		/>
	);
}
