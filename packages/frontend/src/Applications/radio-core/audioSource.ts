/**
 * Which copy of a recording to play.
 *
 * Every item has a canonical `url` pointing at the source recording. Some also
 * have an `enhanced_url` — a noise-reduced render produced for listening. The
 * enhanced copy is the default; the Settings toggle switches back to the
 * original for anyone who would rather hear the tape as it was.
 */
export interface AudioSourceItem {
	url: string;
	enhanced_url?: string | null;
}

/**
 * Resolve the URL to play.
 *
 * `url` is always populated and always points at the source recording, so it is
 * the safe fallback: a file the enhancement pass has not reached yet simply
 * plays unenhanced rather than producing an undefined `src`, which would fail
 * silently as a broken audio element.
 */
export const resolveAudioUrl = (
	item: AudioSourceItem,
	preferOriginal: boolean,
): string => {
	if (preferOriginal) return item.url;
	return item.enhanced_url ?? item.url;
};
