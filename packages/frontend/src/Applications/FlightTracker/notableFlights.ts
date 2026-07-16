// The four hijacked flights of September 11, 2001. Always-on highlight target
// for the Flight Tracker. This list is the single source of truth; the data for
// these flights is loaded by the separate "notable flights" data story — until
// then nothing matches and the highlight simply renders nothing.
//
// `isNotable` deliberately covers ONLY the crashed four: crash-site pins,
// persist-at-impact landing behavior, and the ACTIVE TRACK badge all key off
// it. Observer aircraft (below) get the highlight treatment in their own
// blue-green color but none of the crash semantics.
export const NOTABLE_FLIGHTS = ["AA11", "UA175", "AA77", "UA93"] as const;

// Witness aircraft curated alongside the notables: GOFER06 is the Minnesota
// ANG C-130H that was asked to follow AA77 (saw the Pentagon impact) and later
// overflew the UA93 crash site. Highlighted, never clustered, but not a crash.
export const OBSERVER_FLIGHTS = ["GOFER06"] as const;

const NOTABLE_SET: ReadonlySet<string> = new Set(NOTABLE_FLIGHTS);
const OBSERVER_SET: ReadonlySet<string> = new Set(OBSERVER_FLIGHTS);

export function isNotable(flight: string): boolean {
	return NOTABLE_SET.has(flight);
}

export function isObserver(flight: string): boolean {
	return OBSERVER_SET.has(flight);
}
