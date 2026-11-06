import { epgIcons } from "../TV/epgIcons";
import { MediaCardRow, type MediaCardEntry } from "./MediaCardRow";

/** A media entry already narrowed to a TV channel by the caller. */
export type TvEditorEntry = MediaCardEntry;

/**
 * Station logo for a TV channel slug — the same registered icons the EPG
 * panel renders; a couple of channels have no logo of their own and fall
 * back to the generic TV glyph.
 */
export function stationLogo(itemId: string): string {
	return epgIcons.channels[itemId.toLowerCase()] ?? epgIcons.tv;
}

/**
 * The Media tab's TV section: one card per TV entry, drawn by the shared
 * MediaCardRow. Artwork is bundled and synchronous — every slug resolves,
 * falling back to the generic TV glyph.
 */
export function MediaTvRow({
	entries,
	selectedUid,
	onSelect,
	onEdit,
	onRemove,
}: {
	entries: TvEditorEntry[];
	selectedUid: string | null;
	onSelect: (uid: string) => void;
	onEdit: (uid: string) => void;
	onRemove: (uid: string) => void;
}) {
	return (
		<MediaCardRow
			entries={entries}
			selectedUid={selectedUid}
			onSelect={onSelect}
			onEdit={onEdit}
			onRemove={onRemove}
			logoFor={stationLogo}
			logoClassName="playlistMediaCardLogoPixel"
			listLabel="TV channels"
		/>
	);
}
