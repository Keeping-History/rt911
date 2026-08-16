import { ClassicyButton, ClassicyIcons } from "classicy";
import "../TV/epgIcons"; // side effect: registers ClassicyIcons.applications.epg
import type { EpgIconNamespace } from "../TV/epgIcons";
import type { MediaEntry } from "../../Providers/Playlist/playlistTypes";
import type { EditorEntry } from "./editorState";
import { playlistEditorIcons } from "./playlistIcons";

/** A media entry already narrowed to a TV channel by the caller. */
export type TvEditorEntry = EditorEntry & { entry: MediaEntry };

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
						<ClassicyButton
							buttonShape="square"
							buttonSize="small"
							margin="sm"
							aria-label={`Edit ${e.entry.itemId.toUpperCase()}`}
							onClickFunc={() => onEdit(e.uid)}
						>
							<img src={playlistEditorIcons.edit} alt="" />
						</ClassicyButton>
						<ClassicyButton
							buttonShape="square"
							buttonSize="small"
							margin="sm"
							aria-label={`Remove ${e.entry.itemId.toUpperCase()}`}
							onClickFunc={() => onRemove(e.uid)}
						>
							<img src={playlistEditorIcons.trash} alt="" />
						</ClassicyButton>
					</div>
				</div>
			))}
		</div>
	);
}
