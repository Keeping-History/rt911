/**
 * The HyperCard inspector's picker for directusPager's `itemId` field (issue
 * #560) — browse `pager_items`, filtered server-side the same way
 * `PagerDecoder.tsx`'s own filter bar works (provider exact-match, recipient
 * substring), with the search box driving a message-text substring filter.
 * `itemId` stores an array (see `DirectusPagerPart.tsx`), so this picker
 * always runs in multi-select mode.
 */
import { ClassicyInput, ClassicyPopUpMenu } from "classicy";
import { useCallback, useEffect, useState } from "react";
import {
	fetchDirectusPagerList,
	fetchDirectusPagerProviders,
	type DirectusPagerListItem,
} from "./directusCollections";
import { HyperCardOptionPickerField, type HyperCardItemPickerFilters, type HyperCardItemPickerRow } from "./HyperCardItemPicker";

function toRow(item: DirectusPagerListItem): HyperCardItemPickerRow {
	const prefix = item.provider ? `${item.provider} — ` : "";
	return { id: String(item.id), label: `${prefix}${item.message}` };
}

export function PagerMessagePicker({ value, onChange }: { value: unknown; onChange: (value: unknown) => void }) {
	const [providers, setProviders] = useState<string[]>([]);
	useEffect(() => {
		let cancelled = false;
		fetchDirectusPagerProviders().then((p) => {
			if (!cancelled) setProviders(p);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const fetchItems = useCallback(async (query: string, filters: HyperCardItemPickerFilters) => {
		const provider = typeof filters.provider === "string" && filters.provider !== "" ? filters.provider : undefined;
		const recipient =
			typeof filters.recipient === "string" && filters.recipient !== "" ? filters.recipient : undefined;
		const rows = await fetchDirectusPagerList({ provider, recipient, message: query || undefined });
		return rows.map(toRow);
	}, []);

	return (
		<HyperCardOptionPickerField
			label="Pager Messages"
			value={value}
			onChange={onChange}
			pickerKey="pager_message"
			title="Choose Pager Messages"
			fetchItems={fetchItems}
			initialFilters={{ provider: "", recipient: "" }}
			searchPlaceholder="Search message text"
			emptyMessage="No pager messages match."
			renderFilterBar={(filters, setFilters) => (
				<>
					<ClassicyPopUpMenu
						id="pager_message_picker_provider"
						label="Provider"
						labelPosition="left"
						size="mini"
						placeholder="All providers"
						options={[{ value: "", label: "All providers" }, ...providers.map((p) => ({ value: p, label: p }))]}
						selected={typeof filters.provider === "string" ? filters.provider : ""}
						onChangeFunc={(e) => setFilters({ provider: e.target.value })}
					/>
					<ClassicyInput
						id="pager_message_picker_recipient"
						labelTitle="Recipient"
						labelPosition="left"
						placeholder="Recipient id"
						prefillValue={typeof filters.recipient === "string" ? filters.recipient : ""}
						onChangeFunc={(e) => setFilters({ recipient: e.target.value })}
					/>
				</>
			)}
		/>
	);
}
