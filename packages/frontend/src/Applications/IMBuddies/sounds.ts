/**
 * Named sounds registered with Classicy's sound manager. Assets are supplied
 * separately and loaded with ClassicySoundLoad; these names are what the app
 * plays by, and what ClassicySoundDisableOne mutes by.
 */
export const IM_SOUNDS = {
	signOn: "IMBuddiesSignOn",
	buddyIn: "IMBuddiesBuddyIn",
	buddyOut: "IMBuddiesBuddyOut",
	receive: "IMBuddiesReceive",
	send: "IMBuddiesSend",
} as const;

/**
 * Which door sounds a roster change earns.
 *
 * `prev === null` means this is the first roster of the session and returns
 * nothing: connecting mid-morning with buddies already online must not fire a
 * door-open for each. A buddy appearing for the first time is likewise silent —
 * that is configuration arriving, not somebody signing on.
 *
 * A buddy present in `prev` but ABSENT from `next` is silent too, deliberately:
 * MediaStreamProvider replaces chatBuddies wholesale on every chat_roster
 * frame, so an entry can vanish for reasons that have nothing to do with a
 * person leaving (a teacher narrowing the roster, a reconnect that briefly
 * resends a smaller list, a filter change). Only iterating `next`'s keys is
 * what produces this silence — treating a disappearance as equivalent to
 * "went offline" would print a buddyOut door-chime for what is really a
 * configuration change, not a departure. If a real "buddy actually left"
 * signal is ever needed, it should be its own explicit wire event, not
 * inferred from roster-shrinkage.
 */
export function presenceSounds(
	prev: ReadonlyMap<number, boolean> | null,
	next: ReadonlyMap<number, boolean>,
): string[] {
	if (prev === null) return [];
	const out: string[] = [];
	for (const [profile, online] of next) {
		if (!prev.has(profile)) continue;
		const was = prev.get(profile);
		if (was === online) continue;
		out.push(online ? IM_SOUNDS.buddyIn : IM_SOUNDS.buddyOut);
	}
	return out;
}
