import type { HyperCardPartProps } from "classicy";
import { useMemo } from "react";
import { fetchDirectusPagerItem } from "./directusCollections";
import { resolveItemId, useDirectusItem } from "./useDirectusItem";
import "./DirectusPagerPart.css";

/**
 * `directusPager` HyperCard part — embeds one instant pager message from the
 * `pager_items` Directus collection, styled as a pager readout.
 *
 *   { "id": "page", "type": "directusPager", "rect": [16, 40, 388, 140],
 *     "options": { "itemId": 128 } }
 *
 * `itemId` resolves through the stack expression engine (so it may reference a
 * variable/field).
 */

interface DirectusPagerOptions {
	itemId?: string | number;
	/** Show the provider/recipient/mode metadata row (default true). */
	showMeta: boolean;
}

function readOptions(options: Record<string, unknown>): DirectusPagerOptions {
	const o = options;
	return {
		itemId:
			typeof o.itemId === "string" || typeof o.itemId === "number" ? o.itemId : undefined,
		showMeta: o.showMeta !== false,
	};
}

function formatTimestamp(iso: string | null | undefined): string {
	if (!iso) return "";
	const hasZone = /[zZ]$|[+-]\d\d:?\d\d$/.test(iso.trim());
	const d = new Date(hasZone ? iso : `${iso}Z`);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleString("en-US", {
		timeZone: "UTC",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

export const DirectusPagerPart = ({ options, value, resolve }: HyperCardPartProps) => {
	const opts = useMemo(() => readOptions(options), [options]);
	const id = resolveItemId(opts.itemId, value, resolve);
	const state = useDirectusItem(id, fetchDirectusPagerItem);

	if (state.status === "error") {
		return (
			<div className="classicyHyperCardPager classicyHyperCardPagerMessage" role="alert">
				Could not load page — {state.message}
			</div>
		);
	}
	if (state.status === "loading") {
		return <div className="classicyHyperCardPager classicyHyperCardPagerMessage">Loading page…</div>;
	}
	if (state.status !== "ready") {
		return <div className="classicyHyperCardPager classicyHyperCardPagerMessage">No page selected</div>;
	}

	const { item } = state;
	const meta = [item.provider, item.recipient_id && `→ ${item.recipient_id}`, item.mode]
		.filter(Boolean)
		.join("  ·  ");

	return (
		<div className="classicyHyperCardPager">
			<div className="classicyHyperCardPagerScreen">
				<div className="classicyHyperCardPagerHeader">
					<span className="classicyHyperCardPagerTime">{formatTimestamp(item.start_date)}</span>
				</div>
				<p className="classicyHyperCardPagerBody">{item.message}</p>
				{opts.showMeta && meta && <div className="classicyHyperCardPagerMeta">{meta}</div>}
			</div>
		</div>
	);
};
