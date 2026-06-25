/**
 * Final volume (0..1) handed to a grid player's <ReactPlayer>.
 *
 * The universal `volumeLimit` is a hard ceiling: a player never plays louder
 * than the limit, no matter its own slider. A muted player is always silent,
 * but its stored per-player value is preserved for unmute.
 */
export function resolveGridVolume(
	perPlayerVolume: number | undefined,
	volumeLimit: number,
	isMuted: boolean,
): number {
	if (isMuted) return 0;
	return Math.min(perPlayerVolume ?? 1, volumeLimit);
}
