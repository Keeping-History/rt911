import { ClassicyIcons } from "classicy";
import "../TV/epgIcons"; // side effect: registers ClassicyIcons.applications.epg
import type { EpgIconNamespace } from "../TV/epgIcons";
import { MediaCardRow, type MediaCardEntry } from "./MediaCardRow";

/** A media entry already narrowed to a TV channel by the caller. */
export type TvEditorEntry = MediaCardEntry;

// Read lazily so the lookup always sees the object epgIcons.ts registered.
// The cast is needed because classicy no longer declares the epg namespace.
const epgIcons = () =>
	(ClassicyIcons.applications as unknown as { epg: EpgIconNamespace }).epg;

/**
 * Station logo for a TV channel slug — the same registered icons the EPG
 * panel renders; a couple of channels have no logo of their own and fall
 * back to the generic TV glyph.
 */
export function stationLogo(itemId: string): string {
	const epg = epgIcons();
	return epg.channels[itemId.toLowerCase()] ?? epg.tv;
}

/**
 * The Media tab's TV section: one card per TV entry, drawn by the shared
 * MediaCardRow. Artwork is bundled and synchronous — every slug resolves,
 * falling back to the generic TV glyph.
 */
export function MediaTvRow({
	entries,
	selectedUid,
	onEdit,
	onRemove,
}: {
	entries: TvEditorEntry[];
	selectedUid: string | null;
	onEdit: (uid: string) => void;
	onRemove: (uid: string) => void;
}) {
	return (
		<MediaCardRow
			entries={entries}
			selectedUid={selectedUid}
			onEdit={onEdit}
			onRemove={onRemove}
			logoFor={stationLogo}
			logoClassName="playlistMediaCardLogoPixel"
			listLabel="TV channels"
		/>
	);
}
