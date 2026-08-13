package model

import "time"

// Room command actions. A teacher's live control over the students following
// their playlist — the live counterpart to the pre-authored schedule the
// playlist engine already runs client-side.
const (
	// RoomActionJump moves every student's virtual clock to Time. The client
	// routes this through its single clock-writer seam, exactly as a scheduled
	// playlist jump does.
	RoomActionJump = "jump"
	// RoomActionFocus brings App (a Classicy app id, e.g. "TV.app") to front.
	RoomActionFocus = "focus"
	// RoomActionMessage shows Message to the room.
	RoomActionMessage = "message"
	// RoomActionLock locks or unlocks one control surface for the room: Target
	// names the surface and On is the state to move it to. A toggle is resolved
	// by the teacher's client, not here — the server holds no lock state, so
	// each command carries the absolute value it wants rather than "flip it".
	RoomActionLock = "lock"
)

// Lock targets. Only the clock is implemented; "content" exists in the teacher
// UI as a disabled control and is deliberately NOT accepted here yet. Accepting
// a target no client acts on would make a dead button look like a working one.
const (
	RoomLockClock = "clock"
)

// RoomCommand is one live teacher action, addressed to a room.
//
// A "room" is a playlist id: students following ?playlist=<id> are its members.
// The streamer otherwise knows nothing about playlists — they are authored in
// Directus and executed client-side — so the id travels as an opaque string and
// is never resolved here.
type RoomCommand struct {
	Room   string `json:"room"`
	Action string `json:"action"`
	// Time is the jump target for RoomActionJump: a virtual (2001) instant in
	// UTC, not wall time.
	Time    time.Time `json:"time,omitempty"`
	App     string    `json:"app,omitempty"`
	Message string    `json:"message,omitempty"`
	// Target is the lock surface for RoomActionLock (see RoomLock*).
	Target string `json:"target,omitempty"`
	// On is the lock state for RoomActionLock. No omitempty: false is the
	// unlock command, and omitempty would drop it off the wire entirely.
	On bool `json:"on"`
}

// ValidRoomAction reports whether action is one this server will relay.
// Unknown actions are rejected at the operator boundary rather than forwarded,
// so a typo fails visibly instead of reaching clients that silently ignore it.
func ValidRoomAction(action string) bool {
	switch action {
	case RoomActionJump, RoomActionFocus, RoomActionMessage, RoomActionLock:
		return true
	}
	return false
}

// ValidRoomLockTarget reports whether target is a lock surface this server
// will relay.
func ValidRoomLockTarget(target string) bool {
	return target == RoomLockClock
}
