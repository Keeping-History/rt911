import type { ActionMessage } from "classicy";

/**
 * One-shot remote tune command delivered through the store (TVContext's
 * pattern): `seq` is monotonic so the component applies each command exactly
 * once, retrying while the station list doesn't contain the slug yet.
 *
 * Moved here from the deleted `RadioScanner/RadioScannerContext.ts` (radio-
 * traffic-redesign plan, Step 20): `Providers/Playlist/PlaylistProvider.tsx`
 * still dispatches this for the non-broadcast half of the "radio" playlist
 * catalog (comm/ATC traffic, as opposed to the broadcast stations routed to
 * RadioTuner), and the action `type` string is unchanged so the wire shape
 * this produces is identical to before the RadioScanner shell was deleted.
 */
export interface RadioRemoteCommand {
	seq: number;
	kind: "tune";
	station: string;
}

/** Tune the comm-traffic scanner to a station by its slug (station key). */
export const radioTuneStation = (station: string): ActionMessage => ({
	type: "ClassicyAppRadioScannerTuneStation",
	station,
});
