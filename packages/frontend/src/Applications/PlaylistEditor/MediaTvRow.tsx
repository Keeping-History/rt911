import { CHANNEL_LOGOS, EPG_ICONS } from "../TV/epgIcons";
import type { MediaEntry } from "../../Providers/Playlist/playlistTypes";
import editPng from "./edit.png";
import trashPng from "./trash.png";
import type { EditorEntry } from "./editorState";

/** A media entry already narrowed to a TV channel by the caller. */
export type TvEditorEntry = EditorEntry & { entry: MediaEntry };

const GENERIC_TV_ICON = EPG_ICONS.tv;

/**
 * Station logo for a TV channel slug. The EPG panel renders these same
 * repo-owned assets (see data/channelLogos.ts); a couple of channels have no
 * logo of their own and fall back to the generic TV glyph.
 */
export function stationLogo(itemId: string): string {
	return CHANNEL_LOGOS[itemId.toLowerCase()] ?? GENERIC_TV_ICON;
}

/**
 * The Media tab's TV section: one card per TV entry — station logo, slug, and
 * pencil/trash icon buttons — in a single side-scrolling row. Pencil mirrors
 * the tree rows' Edit (select + reveal the Settings window); trash removes.
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
		<div className="playlistMediaTvRow" role="list" aria-label="TV channels">
			{entries.map((e) => (
				<div
					key={e.uid}
					role="listitem"
					className={`playlistMediaTvCard${e.uid === selectedUid ? " playlistMediaTvCardSelected" : ""}`}
				>
					<img className="playlistMediaTvLogo" src={stationLogo(e.entry.itemId)} alt="" />
					<span className="playlistMediaTvLabel">{e.entry.itemId.toUpperCase()}</span>
					<div className="playlistMediaTvButtons">
						<button
							type="button"
							className="playlistIconButton"
							aria-label={`Edit ${e.entry.itemId.toUpperCase()}`}
							onClick={() => onEdit(e.uid)}
						>
							<img src={editPng} alt="" />
						</button>
						<button
							type="button"
							className="playlistIconButton"
							aria-label={`Remove ${e.entry.itemId.toUpperCase()}`}
							onClick={() => onRemove(e.uid)}
						>
							<img src={trashPng} alt="" />
						</button>
					</div>
				</div>
			))}
		</div>
	);
}
