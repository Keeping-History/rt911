/**
 * Hide channels the user switched off in Settings from the EPG grid.
 *
 * The join is `EPGChannel.name` against a source slug, and it is case-insensitive
 * for the same reason `resolveChannelId` in TV.tsx is: the two lists come from
 * different places (guide.json vs the streamer's `sources.video`) and only
 * happen to agree on case today.
 *
 * `disabledChannels` is a BLACKLIST, so a channel that is absent from it stays
 * visible — including one with no source at all. The guide currently carries
 * WNYW, which no source provides; it can never appear in Settings, so it can
 * never be switched off, and hiding it would remove a channel the user was
 * given no way to bring back.
 */
export function visibleEpgChannels<T extends { name: string }>(
	channels: readonly T[],
	disabledChannels: readonly string[] | undefined,
): T[] {
	if (!disabledChannels?.length) return [...channels];
	const off = new Set(disabledChannels.map((c) => c.toLowerCase()));
	return channels.filter((c) => !off.has(c.name.toLowerCase()));
}
