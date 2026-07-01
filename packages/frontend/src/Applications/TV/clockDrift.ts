/**
 * The virtual clock's `dateTime` (from `useClassicyDateTime()`) is the raw
 * Zustand store value, only updated on minute boundaries — not a live tick.
 * Any "now" derived straight from it can be up to just-under-a-minute stale.
 * Compensate by adding real wall-clock time elapsed since it last changed.
 */
export function resolveVirtualNowMs(
	storeDateTime: string,
	dateTimeUpdatedAtMs: number,
	realNowMs: number,
): number {
	const elapsedRealMs = realNowMs - dateTimeUpdatedAtMs;
	return new Date(storeDateTime).getTime() + elapsedRealMs;
}
