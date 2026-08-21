import { ClassicyButton, ClassicyControlLabel } from "classicy";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { MediaEntry } from "../../Providers/Playlist/playlistTypes";
import type { EditorEntry } from "./editorState";
import { playlistEditorIcons } from "./playlistIcons";

/** A media entry the caller has already narrowed to one station-shaped app. */
export type MediaCardEntry = EditorEntry & { entry: MediaEntry };

/**
 * A side-scrolling row of station cards — logo, call sign, pencil/trash — for
 * the Media tab's sections whose entries address a whole station rather than a
 * single clip (TV Channels, Radio Stations). Pencil mirrors the tree rows' Edit
 * (select + reveal the Settings window); trash removes. Clicking the card
 * itself (or Enter/Space while it's focused) expands the entry's timeline bar
 * via `onSelect` — a lighter-weight action than Edit, which also opens the
 * Settings window.
 *
 * Where the artwork comes from is the caller's business: TV reads the bundled
 * EPG icons synchronously, radio reads a Directus-backed map that only arrives
 * after first paint. `logoFor` may return undefined — the call sign is always
 * rendered, so a card without artwork still identifies its station.
 */
export function MediaCardRow({
	entries,
	selectedUid,
	onSelect,
	onEdit,
	onRemove,
	logoFor,
	logoClassName = "",
	listLabel,
}: {
	entries: MediaCardEntry[];
	selectedUid: string | null;
	/** Expands this entry's timeline bar (and, via the reducer's single
	 * selectedUid, collapses whatever bar was previously expanded). */
	onSelect: (uid: string) => void;
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
				const handleKeyDown = (ev: ReactKeyboardEvent<HTMLDivElement>) => {
					if (ev.key !== "Enter" && ev.key !== " ") return;
					ev.preventDefault();
					onSelect(e.uid);
				};
				return (
					<div
						key={e.uid}
						role="listitem"
						tabIndex={0}
						className={`playlistMediaCard${e.uid === selectedUid ? " playlistMediaCardSelected" : ""}`}
						onClick={() => onSelect(e.uid)}
						onKeyDown={handleKeyDown}
					>
						{logo ? (
							<img className={logoClass} src={logo} alt="" />
						) : (
							<div className="playlistMediaCardLogo" />
						)}
						<ClassicyControlLabel label={label} labelSize="small" />
						{/* stopPropagation here, not inside each onClickFunc: ClassicyButton's
						  * callback shape isn't guaranteed to forward the native event (it
						  * doesn't everywhere else in this codebase), but the click DOM event
						  * itself always bubbles through this wrapper on its way to the card's
						  * onClick above, so stopping it here reliably keeps Edit/Remove from
						  * also firing a card-level select. */}
						<div
							className="playlistMediaCardButtons"
							onClick={(ev) => ev.stopPropagation()}
							onKeyDown={(ev) => ev.stopPropagation()}
						>
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
