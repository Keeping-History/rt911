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
}

// ValidRoomAction reports whether action is one this server will relay.
// Unknown actions are rejected at the operator boundary rather than forwarded,
// so a typo fails visibly instead of reaching clients that silently ignore it.
func ValidRoomAction(action string) bool {
	switch action {
	case RoomActionJump, RoomActionFocus, RoomActionMessage:
		return true
	}
	return false
}
