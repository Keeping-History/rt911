import { useEffect, useState } from "react";

// Shared load plumbing for id-keyed collection embeds (news, pager, …). The
// audio/video parts predate this and inline their own copy; new single-item
// parts use these helpers instead of duplicating the fetch/abort/load-state
// dance.

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
