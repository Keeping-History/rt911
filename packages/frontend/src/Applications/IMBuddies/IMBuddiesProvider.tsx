// The single owner of IM Buddies chat state. Every window (Sign On, Buddy
// List, Chat, Get Info) reads from useIMBuddies() — none of them subscribes to
// MediaStreamContext or touches the socket directly (hard rule 1).
import { ClassicySoundActionTypes, useClassicyDateTime, useSoundDispatch } from "classicy";
import {
	createContext,
	type FC,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	type ChatBuddy,
	type ChatMessage,
	type ChatStateReason,
	MediaStreamContext,
} from "../../Providers/MediaStream/MediaStreamContext";
import { shouldSeek } from "../../Providers/MediaStream/seekDetection";
import { virtualUtcMs } from "../../Providers/MediaStream/virtualClock";
import { IM_SOUNDS, presenceSounds } from "./sounds";

const APP_ID = "IMBuddies.app";
/**
 * Backlog page size for a history re-fetch — both the one a backward seek
 * triggers per open window and the one opening a window triggers for itself.
 */
const HISTORY_PAGE_LIMIT = 40;

export interface Conversation {
	messages: ChatMessage[];
	unread: number;
}

export interface IMBuddiesValue {
	/**
	 * "Sign On pressed AND the chat channel is subscribed" (design.md) — NOT
	 * the raw WebSocket flag. Exposing MediaStreamContext's `connected`
	 * verbatim here meant a healthy socket (the normal case) hid the Sign On
	 * window outright, so the student could never sign on at all; deriving it
	 * from `signedOn && socketConnected` also gives the design's "socket drops
	 * → the Sign On window returns" without a second code path.
	 */
	connected: boolean;
	enabled: boolean;
	reason: ChatStateReason;
	buddies: ChatBuddy[];
	conversationFor: (profile: number) => Conversation;
	typingProfile: number | null;
	openChats: number[];
	openInfo: number[];
	signOn: () => void;
	signOff: () => void;
	openChat: (profile: number) => void;
	closeChat: (profile: number) => void;
	openInfoFor: (profile: number) => void;
	closeInfoFor: (profile: number) => void;
	send: (profile: number, body: string) => void;
	markRead: (profile: number) => void;
	/**
	 * The buddy currently highlighted in the Buddy List — lifted up from that
	 * window's own local state (where it used to live) so the People menu's
	 * New Message / Get Info items can act on the same selection a student
	 * just clicked, rather than only the window itself being able to see it.
	 */
	selectedBuddy: number | null;
	selectBuddy: (profile: number | null) => void;
}

const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_CONVERSATION: Conversation = { messages: EMPTY_MESSAGES, unread: 0 };

const IMBuddiesContext = createContext<IMBuddiesValue | null>(null);

export function useIMBuddies(): IMBuddiesValue {
	const ctx = useContext(IMBuddiesContext);
	if (!ctx) {
		throw new Error("useIMBuddies must be used within an IMBuddiesProvider");
	}
	return ctx;
}

function withValue(list: number[], value: number): number[] {
	return list.includes(value) ? list : [...list, value];
}

function withoutValue(list: number[], value: number): number[] {
	return list.includes(value) ? list.filter((v) => v !== value) : list;
}

export const IMBuddiesProvider: FC<{ children: ReactNode }> = ({ children }) => {
	const {
		chatBuddies,
		chatEnabled,
		chatReason,
		chatMessages,
		chatTypingProfile,
		// Renamed on destructure: this is the raw socket flag, which is only
		// half of what consumers call `connected` (see IMBuddiesValue.connected).
		connected: socketConnected,
		subscribeChat,
		unsubscribeChat,
		sendChat,
		requestChatHistory,
		appendLocalChatMessage,
	} = useContext(MediaStreamContext);

	const soundDispatch = useSoundDispatch();
	const play = useCallback(
		(sound: string) =>
			soundDispatch({ type: ClassicySoundActionTypes.ClassicySoundPlay, sound }),
		[soundDispatch],
	);

	// This feature only READS the clock — it never calls setDateTime/
	// setDateTimeFromUtc. `virtualUtcMs` strips the display timezone back off
	// (frontend hard rule 3): `localDate` is a display value, while every chat
	// timestamp on the wire is true UTC. The ref mirror is assigned during
	// render so `send` below can stamp the current instant WITHOUT taking
	// localDate as a dependency — that ticks every second and would rebuild
	// this provider's whole context value once a second.
	const { localDate, tzOffset } = useClassicyDateTime({ tick: true });
	const virtualNowMsRef = useRef(virtualUtcMs(localDate, tzOffset));
	virtualNowMsRef.current = virtualUtcMs(localDate, tzOffset);

	const [signedOn, setSignedOn] = useState(false);
	const [openChats, setOpenChats] = useState<number[]>([]);
	const [openInfo, setOpenInfo] = useState<number[]>([]);
	const [readMarks, setReadMarks] = useState<Record<number, number>>({});
	const [selectedBuddy, setSelectedBuddy] = useState<number | null>(null);
	const selectBuddy = useCallback((profile: number | null) => setSelectedBuddy(profile), []);

	// Ref-counted subscribe while signed on. The cleanup fires both when
	// signedOn flips back to false (signOff) and when this provider unmounts
	// while still signed on — one effect covers both cases in the brief.
	useEffect(() => {
		if (!signedOn) return;
		subscribeChat(APP_ID);
		return () => unsubscribeChat(APP_ID);
	}, [signedOn, subscribeChat, unsubscribeChat]);

	const signOn = useCallback(() => setSignedOn(true), []);

	// unsubscribeChat deliberately does NOT clear chatBuddies/chatMessages/
	// chatTypingProfile/chatError in MediaStreamProvider (by design — those are
	// its state, not ours, and other subscribers may still want them). But the
	// view state layered on top HERE — which windows are open, and what's been
	// read — is ours, and a sign-off followed by a sign-on must not resurrect a
	// previous session's open windows or read-marks. Clear it on the way out.
	const signOff = useCallback(() => {
		setSignedOn(false);
		setOpenChats([]);
		setOpenInfo([]);
		setReadMarks({});
		setSelectedBuddy(null);
	}, []);

	// A backward seek (below) re-requests history that overlaps what live
	// delivery already appended to chatMessages — the server resends the same
	// message_id, and MediaStreamProvider appends unconditionally. Per
	// websocket-protocol.md, message_id is "echoed so a client can dedupe",
	// and this is that seam. `message_id === 0` means persistence was skipped
	// server-side (no db pool) — it's not a real identity, so two id-0
	// messages are never considered duplicates; only ids > 0 get deduped.
	const conversationsByProfile = useMemo(() => {
		const map = new Map<number, ChatMessage[]>();
		const seenIdsByProfile = new Map<number, Set<number>>();
		for (const message of chatMessages) {
			if (message.message_id > 0) {
				let seen = seenIdsByProfile.get(message.profile);
				if (!seen) {
					seen = new Set();
					seenIdsByProfile.set(message.profile, seen);
				}
				if (seen.has(message.message_id)) continue;
				seen.add(message.message_id);
			}
			const existing = map.get(message.profile);
			if (existing) existing.push(message);
			else map.set(message.profile, [message]);
		}
		return map;
	}, [chatMessages]);

	// The newest message_id set as "read" for a profile. Unread counts every
	// message from the buddy (direction "out") above this mark.
	const markRead = useCallback(
		(profile: number) => {
			const messages = conversationsByProfile.get(profile);
			if (!messages || messages.length === 0) return;
			const newest = messages.reduce((max, m) => Math.max(max, m.message_id), 0);
			setReadMarks((prev) =>
				(prev[profile] ?? 0) >= newest ? prev : { ...prev, [profile]: newest },
			);
		},
		[conversationsByProfile],
	);

	const conversationFor = useCallback(
		(profile: number): Conversation => {
			const messages = conversationsByProfile.get(profile);
			if (!messages) return EMPTY_CONVERSATION;
			const readMark = readMarks[profile] ?? 0;
			const unread = messages.filter(
				(m) => m.direction === "out" && m.message_id > readMark,
			).length;
			return { messages, unread };
		},
		[conversationsByProfile, readMarks],
	);

	// Opening a window is also how it catches up: mark everything currently in
	// the transcript as read immediately, same as AIM, and pull a page of
	// backlog. The re-fetch matters because a backward seek clears the whole
	// transcript in MediaStreamProvider and the seek effect below only
	// re-requests for conversations that were ALREADY open — without this, a
	// conversation reopened after a rewind would show an empty window forever.
	// Re-delivered lines collapse on message_id in conversationsByProfile.
	const openChat = useCallback(
		(profile: number) => {
			setOpenChats((prev) => withValue(prev, profile));
			markRead(profile);
			requestChatHistory(
				profile,
				new Date(virtualNowMsRef.current).toISOString(),
				HISTORY_PAGE_LIMIT,
			);
		},
		[markRead, requestChatHistory],
	);

	const closeChat = useCallback((profile: number) => {
		setOpenChats((prev) => withoutValue(prev, profile));
	}, []);

	const openInfoFor = useCallback((profile: number) => {
		setOpenInfo((prev) => withValue(prev, profile));
	}, []);

	const closeInfoFor = useCallback((profile: number) => {
		setOpenInfo((prev) => withoutValue(prev, profile));
	}, []);

	const send = useCallback(
		(profile: number, body: string) => {
			sendChat(profile, body);
			// The server does not echo the inbound turn — it persists it
			// (session.go's persistInbound) and every live chat_message frame
			// is direction "out"; a direction "in" line comes back only through
			// a chat_history replay. So the student's own words are rendered
			// here or not at all. This lands in the SAME chatMessages array the
			// server frames do, keeping one ordered list rather than two whose
			// interleaving would need an invented sort. message_id 0 is the
			// server's own "not persisted" marker and is already excluded from
			// the dedupe above, so two identical typed lines both survive.
			appendLocalChatMessage({
				message_id: 0,
				profile,
				direction: "in",
				body,
				time: new Date(virtualNowMsRef.current).toISOString(),
				kind: "typed",
			});
			play(IM_SOUNDS.send);
		},
		[sendChat, appendLocalChatMessage, play],
	);

	// Presence sounds (door open/close), fed by Task 4's presenceSounds(prev,
	// next). The ref starts at null — not an empty Map — because that's what
	// tells presenceSounds this is the first roster of the session and
	// suppresses the door-open burst for buddies already online at connect.
	const presenceRef = useRef<Map<number, boolean> | null>(null);
	useEffect(() => {
		const next = new Map(chatBuddies.map((b) => [b.profile, b.online]));
		for (const sound of presenceSounds(presenceRef.current, next)) {
			play(sound);
		}
		presenceRef.current = next;
	}, [chatBuddies, play]);

	// The receive sound: once per genuinely NEW message from a buddy whose
	// conversation has no open window — reusing the same "open window" signal
	// openChat/closeChat maintain above, rather than asking Classicy which
	// window is frontmost. A window the student already has open needs no
	// sound; the message is already visible there.
	//
	// "Genuinely new" is judged by message_id exceeding every id seen so far,
	// NOT by array growth: requestChatHistory (below, and the backlog
	// pagination windows will use later) inserts OLDER messages into this same
	// flat array, and a rewound history page must stay silent.
	const maxMessageIdRef = useRef<number | null>(null);
	useEffect(() => {
		let maxSeen = maxMessageIdRef.current;
		if (maxSeen === null) {
			// First render: record the baseline without sounding for whatever
			// transcript is already present (mirrors presenceRef's null rule).
			maxMessageIdRef.current = chatMessages.reduce(
				(max, m) => Math.max(max, m.message_id),
				0,
			);
			return;
		}
		for (const message of chatMessages) {
			if (message.message_id <= maxSeen) continue;
			maxSeen = message.message_id;
			if (message.direction === "out" && !openChats.includes(message.profile)) {
				play(IM_SOUNDS.receive);
			}
		}
		maxMessageIdRef.current = maxSeen;
	}, [chatMessages, openChats, play]);

	// Backward-seek history: rewinding the virtual clock can leave a buddy
	// holding messages from after the new "now" on screen — exactly the
	// anachronism this product exists to prevent — so every OPEN conversation
	// gets a fresh page re-requested. shouldSeek already encodes the forward
	// (90s) / backward (2s) asymmetry; comparing thresholds by hand here would
	// just duplicate (and risk drifting from) that seam.
	const prevUtcMsRef = useRef<number | null>(null);
	useEffect(() => {
		const nowMs = virtualUtcMs(localDate, tzOffset);
		const prevMs = prevUtcMsRef.current;
		if (prevMs !== null && shouldSeek(prevMs, nowMs)) {
			const before = new Date(nowMs).toISOString();
			for (const profile of openChats) {
				requestChatHistory(profile, before, HISTORY_PAGE_LIMIT);
			}
		}
		prevUtcMsRef.current = nowMs;
	}, [localDate, tzOffset, openChats, requestChatHistory]);

	const value = useMemo<IMBuddiesValue>(
		() => ({
			connected: signedOn && socketConnected,
			enabled: chatEnabled,
			reason: chatReason,
			buddies: chatBuddies,
			conversationFor,
			typingProfile: chatTypingProfile,
			openChats,
			openInfo,
			signOn,
			signOff,
			openChat,
			closeChat,
			openInfoFor,
			closeInfoFor,
			send,
			markRead,
			selectedBuddy,
			selectBuddy,
		}),
		[
			signedOn,
			socketConnected,
			chatEnabled,
			chatReason,
			chatBuddies,
			conversationFor,
			chatTypingProfile,
			openChats,
			openInfo,
			signOn,
			signOff,
			openChat,
			closeChat,
			openInfoFor,
			closeInfoFor,
			send,
			markRead,
			selectedBuddy,
			selectBuddy,
		],
	);

	return <IMBuddiesContext.Provider value={value}>{children}</IMBuddiesContext.Provider>;
};
