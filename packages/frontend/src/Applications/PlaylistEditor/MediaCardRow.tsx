import { ClassicyButton, ClassicyControlLabel } from "classicy";
import type { MediaEntry } from "../../Providers/Playlist/playlistTypes";
import type { EditorEntry } from "./editorState";
import { playlistEditorIcons } from "./playlistIcons";

/** A media entry the caller has already narrowed to one station-shaped app. */
export type MediaCardEntry = EditorEntry & { entry: MediaEntry };

/**
 * A side-scrolling row of station cards — logo, call sign, pencil/trash — for
 * the Media tab's sections whose entries address a whole station rather than a
 * single clip (TV Channels, Radio Stations). Pencil mirrors the tree rows' Edit
 * (select + reveal the Settings window); trash removes.
 *
 * Where the artwork comes from is the caller's business: TV reads the bundled
 * EPG icons synchronously, radio reads a Directus-backed map that only arrives
 * after first paint. `logoFor` may return undefined — the call sign is always
 * rendered, so a card without artwork still identifies its station.
 */
export function MediaCardRow({
	entries,
	selectedUid,
	onEdit,
	onRemove,
	logoFor,
	logoClassName = "",
	listLabel,
}: {
	entries: MediaCardEntry[];
	selectedUid: string | null;
	onEdit: (uid: string) => void;
	onRemove: (uid: string) => void;
	logoFor: (itemId: string) => string | undefined;
	/** Extra class on the logo, for per-section artwork treatment (pixel-art
	 * upscaling for TV's bundled glyphs, a backdrop plate for radio's
	 * transparent station artwork). */
	logoClassName?: string;
	/** Accessible name for the row, e.g. "TV channels". */
	listLabel: string;
}) {
	return (
		<div className="playlistMediaCardRow" role="list" aria-label={listLabel}>
			{entries.map((e) => {
				const label = e.entry.itemId.toUpperCase();
				const logo = logoFor(e.entry.itemId);
				const logoClass = `playlistMediaCardLogo ${logoClassName}`.trim();
				return (
					<div
						key={e.uid}
						role="listitem"
						className={`playlistMediaCard${e.uid === selectedUid ? " playlistMediaCardSelected" : ""}`}
					>
						{logo ? (
							<img className={logoClass} src={logo} alt="" />
						) : (
							<div className="playlistMediaCardLogo" />
						)}
						<ClassicyControlLabel label={label} labelSize="small" />
						<div className="playlistMediaCardButtons">
							<ClassicyButton
								buttonShape="square"
								buttonSize="small"
								margin="sm"
								aria-label={`Edit ${label}`}
								onClickFunc={() => onEdit(e.uid)}
							>
								<img src={playlistEditorIcons.edit} alt="" />
							</ClassicyButton>
							<ClassicyButton
								buttonShape="square"
								buttonSize="small"
								margin="sm"
								aria-label={`Remove ${label}`}
								onClickFunc={() => onRemove(e.uid)}
							>
								<img src={playlistEditorIcons.trash} alt="" />
							</ClassicyButton>
						</div>
					</div>
				);
			})}
		</div>
	);
}
