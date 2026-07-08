// The four hijacked flights of September 11, 2001. Always-on highlight target
// for the Flight Tracker. This list is the single source of truth; the data for
// these flights is loaded by the separate "notable flights" data story — until
// then nothing matches and the highlight simply renders nothing.
export const NOTABLE_FLIGHTS = ["AA11", "UA175", "AA77", "UA93"] as const;

const NOTABLE_SET: ReadonlySet<string> = new Set(NOTABLE_FLIGHTS);

export function isNotable(flight: string): boolean {
	return NOTABLE_SET.has(flight);
}
