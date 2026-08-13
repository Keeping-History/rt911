import { ClassicyButton, ClassicyControlGroup } from "classicy";
import { useCallback, useState } from "react";
import { RoomCommandError, sendRoomLock } from "../../Providers/Playlist/roomApi";

export const CONTROL_NO_PLAYLIST = "Open a playlist to control it live.";

interface ControlPanelProps {
	/** The playlist being controlled, or null when none is open. */
	playlistId: string | null;
	playlistTitle?: string;
	/** Injectable for tests; defaults to the real API call. */
	sendLock?: typeof sendRoomLock;
}

/**
 * Live controls for the open playlist — the teacher end of room control.
 *
 * Lock state is held here rather than read back from the server, because the
 * streamer keeps none: a room command is fire-and-forget, so there is nothing
 * to query. Two consequences worth knowing: the toggle resets if this window is
 * reopened (students stay locked — only this button forgets), and two teachers
 * driving one playlist will not see each other's state.
 */
export function ControlPanel({ playlistId, playlistTitle, sendLock = sendRoomLock }: ControlPanelProps) {
	const [clockLocked, setClockLocked] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const toggleClock = useCallback(async () => {
		if (!playlistId || busy) return;
		const next = !clockLocked;
		setBusy(true);
		setError(null);
		try {
			await sendLock(playlistId, "clock", next);
			// Only after the server accepts. Flipping first would leave the
			// button claiming a lock that never reached a single student.
			setClockLocked(next);
		} catch (err) {
			setError(err instanceof RoomCommandError ? err.message : "Command failed.");
		} finally {
			setBusy(false);
		}
	}, [playlistId, busy, clockLocked, sendLock]);

	return (
		<div className="playlistEditorControl">
			{playlistId === null ? (
				<p>{CONTROL_NO_PLAYLIST}</p>
			) : (
				<p>
					Controlling <b>{playlistTitle || "this playlist"}</b>.
				</p>
			)}
			<ClassicyControlGroup label="Lock">
				<ClassicyButton
					depressed={clockLocked}
					disabled={playlistId === null || busy}
					onClickFunc={() => void toggleClock()}
				>
					Clock
				</ClassicyButton>
				{/* Content locking is not built yet. The button is present so the
				    group reads as the pair it will be, and disabled so it cannot
				    imply an effect it does not have. */}
				<ClassicyButton disabled>
					Content
				</ClassicyButton>
			</ClassicyControlGroup>
			{clockLocked && (
				<p>Students cannot change the time until you unlock the clock.</p>
			)}
			{error && <p className="playlistEditorControlError">{error}</p>}
		</div>
	);
}
