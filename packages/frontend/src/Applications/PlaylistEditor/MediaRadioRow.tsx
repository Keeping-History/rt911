import { ClassicyIcons } from "classicy";
import { useMemo } from "react";
import { useStationLogos } from "../radio-core/stationLogos";
import { MediaCardRow, type MediaCardEntry } from "./MediaCardRow";

/** A media entry already narrowed to a broadcast radio station by the caller. */
export type RadioEditorEntry = MediaCardEntry;

/**
 * The Media tab's Radio Stations section: one card per station entry, drawn by
 * the shared MediaCardRow.
 *
 * Unlike TV's bundled EPG artwork, radio logos come from Directus
 * (`useStationLogos`, the time-independent slug → image map the Radio Tuner
 * uses for a dark station). The map is `{}` until that read resolves, so the
 * cards paint with the generic radio glyph and swap in the real artwork on the
 * one re-render that follows — nothing blocks on it, and a failed read simply
 * leaves the glyph in place.
 */
export function MediaRadioRow({
	entries,
	selectedUid,
	onSelect,
	onEdit,
	onRemove,
}: {
	entries: RadioEditorEntry[];
	selectedUid: string | null;
	onSelect: (uid: string) => void;
	onEdit: (uid: string) => void;
	onRemove: (uid: string) => void;
}) {
	const logos = useStationLogos();

	// Case-folded, because the two ends disagree: a playlist entry's itemId is
	// the streamer's source name (the strip's "WINS"), while the map is keyed by
	// the Directus source slug. BROADCAST_STATIONS membership is tested
	// case-insensitively for the same reason.
	const byCallSign = useMemo(() => {
		const map: Record<string, string> = {};
		for (const [slug, image] of Object.entries(logos)) {
			map[slug.toLowerCase()] = image;
		}
		return map;
	}, [logos]);

	return (
		<MediaCardRow
			entries={entries}
			selectedUid={selectedUid}
			onSelect={onSelect}
			onEdit={onEdit}
			onRemove={onRemove}
			// Read lazily: the generic radio glyph is classicy's, and reading it
			// per-render keeps this in step with any icon registration.
			logoFor={(itemId) =>
				byCallSign[itemId.toLowerCase()] ??
				(ClassicyIcons.applications.radio?.app as string | undefined)
			}
			// Station artwork is mostly light-on-transparent, so it needs the
			// same dark plate the tuner's display paints behind it or it would
			// disappear into the card's Platinum background.
			logoClassName="playlistMediaCardLogoPlate"
			listLabel="Radio stations"
		/>
	);
}
