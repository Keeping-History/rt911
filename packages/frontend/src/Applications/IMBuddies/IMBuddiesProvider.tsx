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
/** Backlog page size for the re-fetch a backward seek triggers per open window. */
const SEEK_HISTORY_LIMIT = 40;

export interface Conversation {
	messages: ChatMessage[];
	unread: number;
}

export interface IMBuddiesValue {
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
		connected,
		subscribeChat,
		unsubscribeChat,
		sendChat,
		requestChatHistory,
	} = useContext(MediaStreamContext);

	const soundDispatch = useSoundDispatch();
	const play = useCallback(
		(sound: string) =>
			soundDispatch({ type: ClassicySoundActionTypes.ClassicySoundPlay, sound }),
		[soundDispatch],
	);

	const [signedOn, setSignedOn] = useState(false);
	const [openChats, setOpenChats] = useState<number[]>([]);
	const [openInfo, setOpenInfo] = useState<number[]>([]);
	const [readMarks, setReadMarks] = useState<Record<number, number>>({});

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
	// the transcript as read immediately, same as AIM.
	const openChat = useCallback(
		(profile: number) => {
			setOpenChats((prev) => withValue(prev, profile));
			markRead(profile);
		},
		[markRead],
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
			play(IM_SOUNDS.send);
		},
		[sendChat, play],
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
	// just duplicate (and risk drifting from) that seam. This feature only
	// READS the clock — it never calls setDateTime/setDateTimeFromUtc.
	const { localDate, tzOffset } = useClassicyDateTime({ tick: true });
	const prevUtcMsRef = useRef<number | null>(null);
	useEffect(() => {
		const nowMs = virtualUtcMs(localDate, tzOffset);
		const prevMs = prevUtcMsRef.current;
		if (prevMs !== null && shouldSeek(prevMs, nowMs)) {
			const before = new Date(nowMs).toISOString();
			for (const profile of openChats) {
				requestChatHistory(profile, before, SEEK_HISTORY_LIMIT);
			}
		}
		prevUtcMsRef.current = nowMs;
	}, [localDate, tzOffset, openChats, requestChatHistory]);

	const value = useMemo<IMBuddiesValue>(
		() => ({
			connected,
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
		}),
		[
			connected,
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
		],
	);

	return <IMBuddiesContext.Provider value={value}>{children}</IMBuddiesContext.Provider>;
};
