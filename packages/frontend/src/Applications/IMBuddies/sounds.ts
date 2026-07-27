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
