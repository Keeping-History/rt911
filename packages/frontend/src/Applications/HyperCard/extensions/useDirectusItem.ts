import { useEffect, useState } from "react";

// Shared load plumbing for id-keyed collection embeds (news, pager, …). The
// audio/video parts predate this and inline their own copy; new single-item
// parts use these helpers instead of duplicating the fetch/abort/load-state
// dance.
//
// `resolveItemIds` (issue #560) generalizes `resolveItemId` to the array-
// valued option every picker-backed field now stores; it's option-resolution
// plumbing rather than a fetch, so the weather-station and flight-map parts
// use it too even though they don't otherwise touch this module's fetch hook.

/**
 * Resolve an embed's item id from its authored option (passed through the stack
 * expression engine, so it can reference a variable/field) with a fallback to
 * the part's own field `value`. Returns undefined when nothing usable is set.
 */
export function resolveItemId(
	optionId: string | number | undefined,
	value: string,
	resolve: (expr: string) => string,
): string | undefined {
	const raw = optionId ?? value;
	if (raw === undefined || raw === "") return undefined;
	const resolved = resolve(String(raw)).trim();
	return resolved === "" ? undefined : resolved;
}

/**
 * The array-aware counterpart to {@link resolveItemId} — resolves a HyperCard
 * option that now stores an array (or, for a not-yet-resaved legacy part, a
 * single scalar) into an ordered list of ids, each run through the stack
 * expression engine so any entry may still reference a variable/field. An
 * empty/missing option falls back to the part's own field `value` as a
 * single-entry list, exactly like `resolveItemId`'s own fallback, so an
 * unconfigured legacy part bound to a field keeps working unchanged.
 */
export function resolveItemIds(
	optionIds: unknown,
	value: string,
	resolve: (expr: string) => string,
): string[] {
	const raw: (string | number)[] = Array.isArray(optionIds)
		? optionIds.filter((v): v is string | number => typeof v === "string" || typeof v === "number")
		: typeof optionIds === "string" || typeof optionIds === "number"
			? [optionIds]
			: [];
	if (raw.length === 0) {
		const fallback = resolveItemId(undefined, value, resolve);
		return fallback === undefined ? [] : [fallback];
	}
	return raw.map((r) => resolve(String(r)).trim()).filter((r) => r !== "");
}

export type ItemLoadState<T> =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "ready"; item: T }
	| { status: "error"; message: string };

/**
 * Fetch a single Directus item by resolved id, exposing an idle/loading/ready/
 * error state. One in-flight request per id; aborts on id change / unmount.
 */
export function useDirectusItem<T>(
	id: string | undefined,
	fetcher: (id: string, fetchFn: typeof fetch, signal: AbortSignal) => Promise<T>,
): ItemLoadState<T> {
	const [state, setState] = useState<ItemLoadState<T>>({ status: "idle" });

	useEffect(() => {
		if (id === undefined) {
			setState({ status: "idle" });
			return;
		}
		const controller = new AbortController();
		setState({ status: "loading" });
		fetcher(id, fetch, controller.signal)
			.then((item) => setState({ status: "ready", item }))
			.catch((err: unknown) => {
				if (controller.signal.aborted) return;
				setState({
					status: "error",
					message: err instanceof Error ? err.message : String(err),
				});
			});
		return () => controller.abort();
	}, [id, fetcher]);

	return state;
}
