import { ClassicyAlert, ClassicyApp, useAppManager, useAppManagerDispatch, useClassicyDateTime } from "classicy";
import { useContext, useEffect, useRef, useState } from "react";
import { clampClockIso } from "../../Applications/HyperCard/extensions/dateRange";
import { setDateTimeFromUtc } from "../../Applications/TimeMachine/setVirtualClock";
import { MediaStreamContext } from "../MediaStream/MediaStreamContext";
import { playlistAppMeta } from "./playlistApps";

const appId = "RoomControl.app";
const appName = "Classroom";

/**
 * Applies live teacher commands to this desktop.
 *
 * The streamer relays a teacher's action to every student in the room across
 * every pod (see packages/backend/internal/fanout); this is the client end of
 * that. It lives here rather than in PlaylistProvider because the commands
 * arrive on the WebSocket, and MediaStreamProvider mounts *inside*
 * PlaylistProvider — a parent cannot read its child's context. Mounting it as a
 * desktop child (see Desktop.tsx) is the same shape the HyperCard bridges use.
 *
 * Keyed on `seq`, not on the command's contents: a teacher may legitimately
 * send the same command twice ("focus the TV again"), and an effect keyed on
 * value alone would swallow the repeat.
 */
export function RoomControlBridge() {
	const { roomCommand } = useContext(MediaStreamContext);
	const { setDateTime } = useClassicyDateTime();
	const dispatch = useAppManagerDispatch();
	// Forced clock mode outranks a teacher: while the streamer is driving every
	// client's clock, a room jump must not fight it. Same check the other
	// non-user clock writers make (frontend CLAUDE.md hard rule #2).
	const dateTimeLocked = useAppManager(
		(s) => s.System.Manager.DateAndTime.dateTimeLocked,
	);
	const [note, setNote] = useState<{ seq: number; body: string } | null>(null);

	// The effect below must see the latest writers without re-running when only
	// they change — it runs on a new command, nothing else.
	const latest = useRef({ setDateTime, dispatch, dateTimeLocked });
	latest.current = { setDateTime, dispatch, dateTimeLocked };

	const seq = roomCommand?.seq ?? 0;
	useEffect(() => {
		if (!roomCommand || seq === 0) return;
		const { setDateTime, dispatch, dateTimeLocked } = latest.current;

		switch (roomCommand.action) {
			case "jump": {
				if (dateTimeLocked) return;
				if (!roomCommand.time) return;
				const clamped = clampClockIso(roomCommand.time);
				if (!clamped) {
					console.warn(`Room jump: unparseable date "${roomCommand.time}"`);
					return;
				}
				setDateTimeFromUtc(setDateTime, clamped.iso);
				return;
			}
			case "focus": {
				if (!roomCommand.app) return;
				dispatch({
					type: "ClassicyAppOpen",
					app: { id: roomCommand.app, ...playlistAppMeta(roomCommand.app) },
				});
				return;
			}
			case "message": {
				if (!roomCommand.message) return;
				setNote({ seq, body: roomCommand.message });
				return;
			}
			case "lock": {
				// Only the clock is a real target today; "content" is a disabled
				// button in the teacher UI and the server refuses to relay it.
				if (roomCommand.target !== "clock") return;
				// `on` absent means the field never made it, not "unlock" —
				// acting on that would silently free a locked classroom.
				if (typeof roomCommand.on !== "boolean") return;
				dispatch({
					type: roomCommand.on
						? "ClassicyManagerDateTimeLock"
						: "ClassicyManagerDateTimeUnlock",
				});
				return;
			}
		}
		// Intentionally keyed on seq alone — see the doc comment.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [seq]);

	return (
		<ClassicyApp id={appId} name={appName} icon="" extension addSystemMenu={false}>
			{note && (
				<ClassicyAlert
					key={note.seq}
					id={`${appId}_note_${note.seq}`}
					appId={appId}
					title={appName}
					alertType="note"
					label="Message from your teacher"
					message={note.body}
					onClose={() => setNote(null)}
				/>
			)}
		</ClassicyApp>
	);
}
