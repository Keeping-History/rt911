import type { HyperCardPartProps } from "classicy";
import { useMemo } from "react";
import { fetchDirectusPagerItem } from "./directusCollections";
import { resolveItemIds, useDirectusItem } from "./useDirectusItem";
import "./DirectusPagerPart.css";

/**
 * `directusPager` HyperCard part — embeds one or more instant pager messages
 * from the `pager_items` Directus collection, styled as a pager readout.
 *
 *   { "id": "page", "type": "directusPager", "rect": [16, 40, 388, 140],
 *     "options": { "itemId": [128] } }
 *
 * `itemId` is an array (issue #560's `PagerMessagePicker` always writes one),
 * but a bare scalar/variable-name id is still accepted for a part authored
 * before that change, and each entry resolves through the stack expression
 * engine (so it may reference a variable/field). Two or more ids render as a
 * vertical list of pager readouts.
 */

interface DirectusPagerOptions {
	itemIds: string[];
	/** Show the provider/recipient/mode metadata row (default true). */
	showMeta: boolean;
}

function readOptions(
	options: Record<string, unknown>,
	value: string,
	resolve: (expr: string) => string,
): DirectusPagerOptions {
	const o = options;
	return {
		itemIds: resolveItemIds(o.itemId, value, resolve),
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

/** One pager readout — split out so `DirectusPagerPart` can render several, each with its own load state. */
function PagerMessage({ itemId, showMeta }: { itemId: string; showMeta: boolean }) {
	const state = useDirectusItem(itemId, fetchDirectusPagerItem);

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
				{showMeta && meta && <div className="classicyHyperCardPagerMeta">{meta}</div>}
			</div>
		</div>
	);
}

/**
 * Zero resolved ids renders the same "No page selected" message as before;
 * one id renders exactly as before (a single pager readout, no extra
 * wrapper); two or more render as a scrollable stack of readouts (issue
 * #560).
 */
export const DirectusPagerPart = ({ options, value, resolve }: HyperCardPartProps) => {
	const opts = useMemo(() => readOptions(options, value, resolve), [options, value, resolve]);

	if (opts.itemIds.length === 0) {
		return <div className="classicyHyperCardPager classicyHyperCardPagerMessage">No page selected</div>;
	}
	if (opts.itemIds.length === 1) {
		return <PagerMessage itemId={opts.itemIds[0]} showMeta={opts.showMeta} />;
	}
	return (
		<div className="classicyHyperCardPagerList">
			{opts.itemIds.map((id, i) => (
				<PagerMessage key={`${id}-${i}`} itemId={id} showMeta={opts.showMeta} />
			))}
		</div>
	);
};
