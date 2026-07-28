// The single owner of IM Buddies chat state. Every window (Sign On, Buddy
// List, Chat, Get Info) reads from useIMBuddies() — none of them subscribes to
// MediaStreamContext or touches the socket directly (hard rule 1).
import {
	ClassicySoundActionTypes,
	hasShownStartupScreenThisSession,
	useAppManagerDispatch,
	useClassicyDateTime,
	useSoundDispatch,
} from "classicy";
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
import { useAuth } from "../../Providers/Auth/AuthContext";
import {
	type ChatBuddy,
	type ChatMessage,
	type ChatStateReason,
	MediaStreamContext,
} from "../../Providers/MediaStream/MediaStreamContext";
import { shouldSeek } from "../../Providers/MediaStream/seekDetection";
import { virtualUtcMs } from "../../Providers/MediaStream/virtualClock";
import { isRewound } from "./composeGate";
import { IM_SOUNDS, presenceSounds } from "./sounds";

const APP_ID = "IMBuddies.app";

/**
 * A virtual instant at the resolution the wire actually carries.
 *
 * The streamer formats every chat_message time with Go's time.RFC3339, which
 * has no fractional-seconds component. Comparing a millisecond-precise local
 * value against those truncated ones is comparing two different clocks: within
 * any single second the local one always looks later. Truncating here makes the
 * two sides comparable, and leaves same-second ordering to the arrival-order
 * tiebreak, which is what "the order they were transmitted" means.
 */
export function wireTimestamp(ms: number): string {
	return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}
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
	/**
	 * The newest message instant for a conversation, true UTC ms, or null if it
	 * has never had one. The compose gate's input — see composeGate.ts.
	 */
	lastMessageAtFor: (profile: number) => number | null;
	typingProfile: number | null;
	openChats: number[];
	/**
	 * The buddy the single Get Info window is currently about, or null when it
	 * is closed. One window that retargets, not one per buddy — see openInfoFor.
	 */
	infoProfile: number | null;
	signOn: () => void;
	signOff: () => void;
	openChat: (profile: number) => void;
	closeChat: (profile: number) => void;
	openInfoFor: (profile: number) => void;
	closeInfo: () => void;
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

	const desktopEventDispatch = useAppManagerDispatch();
	const soundDispatch = useSoundDispatch();
	const play = useCallback(
		(sound: string) =>
			soundDispatch({ type: ClassicySoundActionTypes.ClassicySoundPlay, sound }),
		[soundDispatch],
	);

	// This feature only READS the clock — it never calls setDateTime/
	// setDateTimeFromUtc. `virtualUtcMs` strips the display timezone back off
	// (frontend hard rule 3): `localDate` is a display value, while every chat
	// timestamp on the wire is true UTC.
	//
	// The ref mirror lets `send`/`openChat` below stamp the current instant
	// WITHOUT taking localDate as a dependency — that ticks every second and
	// would rebuild this provider's whole context value once a second. It is
	// seeded in the useRef initializer and thereafter updated in an effect, not
	// in the render body: a ref write during render is a side effect, and
	// idempotent-today is not a reason to leave one lying around. Both readers
	// run from user events, which happen after commit, so the effect has always
	// caught up by the time either is called.
	const { localDate, tzOffset } = useClassicyDateTime({ tick: true });
	const virtualNowMsRef = useRef(virtualUtcMs(localDate, tzOffset));
	useEffect(() => {
		virtualNowMsRef.current = virtualUtcMs(localDate, tzOffset);
	}, [localDate, tzOffset]);

	const { user } = useAuth();

	const [signedOn, setSignedOn] = useState(false);
	// Latches auto sign-on to at most once per browser session — see the effect
	// below. Declared here with the state it guards rather than beside that
	// effect, because signOff writes it too.
	const autoSignOnDoneRef = useRef(false);
	const [openChats, setOpenChats] = useState<number[]>([]);
	const [infoProfile, setInfoProfile] = useState<number | null>(null);
	const [readMarks, setReadMarks] = useState<Record<number, number>>({});

	// Per-conversation high-water mark of the newest message instant ever seen,
	// in true UTC ms. Deliberately NOT derived from the current transcript: a
	// backward seek clears chatMessages outright in MediaStreamProvider, so by
	// the moment this matters the message being rewound behind is already gone
	// from it. Deliberately NOT cleared by signOff either (note its absence from
	// that callback) — it is knowledge about the timeline rather than a view of
	// it, and a history replay only ever returns messages BEFORE the current
	// instant, so nothing could rebuild it.
	const [lastMessageAt, setLastMessageAt] = useState<Record<number, number>>({});
	useEffect(() => {
		setLastMessageAt((prev) => {
			let next = prev;
			for (const message of chatMessages) {
				const at = Date.parse(message.time);
				// An unparseable time is skipped rather than allowed to poison the
				// mark — the same tolerance conversationsByProfile's sort applies.
				if (Number.isNaN(at)) continue;
				if (at <= (next[message.profile] ?? Number.NEGATIVE_INFINITY)) continue;
				if (next === prev) next = { ...prev };
				next[message.profile] = at;
			}
			return next;
		});
	}, [chatMessages]);

	const lastMessageAtFor = useCallback(
		(profile: number): number | null => lastMessageAt[profile] ?? null,
		[lastMessageAt],
	);
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

	const signOn = useCallback(() => {
		autoSignOnDoneRef.current = true;
		setSignedOn(true);
	}, []);

	// Auto sign-on once the desktop has finished booting (#321). The flag lives
	// in sessionStorage and classicy exports the reader, so this never touches
	// storage directly.
	//
	// Two guards carry the weight here:
	//
	//   - No Directus user, no auto sign-on. SignOnWindow hands a signed-out
	//     student to the Account app; firing that automatically would drop
	//     someone into a login screen they never asked for on boot.
	//   - The latch (set here, by signOn, and by signOff) makes this fire at
	//     most once per session, so Sign Off actually signs you off.
	useEffect(() => {
		if (autoSignOnDoneRef.current || signedOn) return;
		if (!user || !socketConnected) return;
		if (!hasShownStartupScreenThisSession()) return;
		autoSignOnDoneRef.current = true;
		setSignedOn(true);
	}, [user, socketConnected, signedOn]);

	// unsubscribeChat deliberately does NOT clear chatBuddies/chatMessages/
	// chatTypingProfile in MediaStreamProvider (by design — those are
	// its state, not ours, and other subscribers may still want them). But the
	// view state layered on top HERE — which windows are open, and what's been
	// read — is ours, and a sign-off followed by a sign-on must not resurrect a
	// previous session's open windows or read-marks. Clear it on the way out.
	const signOff = useCallback(() => {
		setSignedOn(false);
		setOpenChats([]);
		setInfoProfile(null);
		setReadMarks({});
		setSelectedBuddy(null);
		// Belt-and-braces, and known to be so: every path that can set
		// signedOn (the auto sign-on effect, and signOn itself) already latches
		// this, so by the time anyone can sign OFF the latch is necessarily
		// already true — removing this line does not fail a single test, which
		// is how that was established rather than assumed. It stays because
		// signOff is where "this session is over" is expressed, and a future
		// third way to sign on should not be able to make Sign Off
		// un-obeyable by forgetting to latch.
		autoSignOnDoneRef.current = true;
	}, []);

	// A backward seek (below) re-requests history that overlaps what live
	// delivery already appended to chatMessages — the server resends the same
	// message_id, and MediaStreamProvider appends unconditionally. Per
	// websocket-protocol.md, message_id is "echoed so a client can dedupe",
	// and this is that seam. `message_id === 0` means persistence was skipped
	// server-side (no db pool) — it's not a real identity, so two id-0
	// messages are never considered duplicates; only ids > 0 get deduped.
	//
	// Arrival order is NOT conversation order. A chat_history replay arrives
	// oldest-first and is appended to the end of this same flat array, so a
	// live message received while the window was closed would otherwise sit
	// above the older lines the replay brings in — a student opening a
	// conversation for the first time would see it scrambled. Sort by
	// (virtual_time, message_id), then by arrival index so the sort is stable
	// on its own terms rather than relying on the engine's: a conversation
	// moves faster than virtual_time's one-second resolution, and two lines in
	// the same second swapping places would reorder a question and its answer.
	// A missing/unparseable `time` falls through to the id/index tiebreak
	// rather than poisoning every comparison it takes part in.
	const conversationsByProfile = useMemo(() => {
		const map = new Map<number, ChatMessage[]>();
		const orderByMessage = new Map<ChatMessage, { time: number; index: number }>();
		const seenIdsByProfile = new Map<number, Set<number>>();
		let index = 0;
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
			orderByMessage.set(message, { time: Date.parse(message.time), index: index++ });
			const existing = map.get(message.profile);
			if (existing) existing.push(message);
			else map.set(message.profile, [message]);
		}
		for (const messages of map.values()) {
			messages.sort((a, b) => {
				// biome-ignore lint/style/noNonNullAssertion: every message in
				// `map` was just recorded in `orderByMessage` on the same pass.
				const ao = orderByMessage.get(a)!;
				// biome-ignore lint/style/noNonNullAssertion: as above.
				const bo = orderByMessage.get(b)!;
				if (!Number.isNaN(ao.time) && !Number.isNaN(bo.time) && ao.time !== bo.time) {
					return ao.time - bo.time;
				}
				// Arrival order, NOT message_id. Within one second, "the order
				// they were transmitted" (#327) is the order this client saw
				// them; a local echo's message_id of 0 is the server's
				// "not persisted" marker, and using it as a position in time
				// sorted every unsent line to the top of the conversation.
				// After a backward seek the array is cleared before the replay,
				// so arrival order is the server's oldest-first order there too.
				return ao.index - bo.index;
			});
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
			// Raise the window if it is ALREADY open (#324) — pressing IM for a
			// buddy you are already talking to must bring that conversation
			// forward rather than silently doing nothing. A window opening for
			// the first time focuses itself on mount instead; this dispatch
			// cannot reach it, because it does not exist yet.
			desktopEventDispatch({
				type: "ClassicyWindowFocus",
				app: { id: APP_ID },
				window: { id: `im_chat_${profile}` },
			});
			requestChatHistory(
				profile,
				new Date(virtualNowMsRef.current).toISOString(),
				HISTORY_PAGE_LIMIT,
			);
		},
		[markRead, requestChatHistory, desktopEventDispatch],
	);

	const closeChat = useCallback((profile: number) => {
		setOpenChats((prev) => withoutValue(prev, profile));
	}, []);

	// ONE Get Info window that retargets, not one per buddy (#325). Appending
	// to a list opened a second window at the same centred position as the
	// first, which then stayed on top — so pressing Info for a different buddy
	// looked like it did nothing at all. Setting a single value means the
	// window that is already open simply changes who it is about.
	const openInfoFor = useCallback((profile: number) => {
		setInfoProfile(profile);
	}, []);

	const closeInfo = useCallback(() => {
		setInfoProfile(null);
	}, []);

	const send = useCallback(
		(profile: number, body: string) => {
			// The composer is already disabled for this case (composeGate), but a
			// disabled button is a UI state and this is the invariant: a turn that
			// sits before the buddy's own previous answer must never reach the
			// wire, whatever a stale render or a stray keystroke does.
			if (isRewound(lastMessageAt[profile] ?? null, virtualNowMsRef.current)) return;
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
				// Stamped at the WIRE's resolution, not the clock's. The server
				// formats with time.RFC3339 — whole seconds, no fractional part
				// (session.go) — so a millisecond-precise echo of "…:03.250Z"
				// sorted AFTER a reply stamped "…:03Z" in the same second, and
				// the student's own line appeared below the answer to it (#327).
				time: wireTimestamp(virtualNowMsRef.current),
				kind: "typed",
			});
			play(IM_SOUNDS.send);
		},
		[sendChat, appendLocalChatMessage, play, lastMessageAt],
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
			lastMessageAtFor,
			typingProfile: chatTypingProfile,
			openChats,
			infoProfile,
			signOn,
			signOff,
			openChat,
			closeChat,
			openInfoFor,
			closeInfo,
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
			lastMessageAtFor,
			chatTypingProfile,
			openChats,
			infoProfile,
			signOn,
			signOff,
			openChat,
			closeChat,
			openInfoFor,
			closeInfo,
			send,
			markRead,
			selectedBuddy,
			selectBuddy,
		],
	);

	return <IMBuddiesContext.Provider value={value}>{children}</IMBuddiesContext.Provider>;
};
