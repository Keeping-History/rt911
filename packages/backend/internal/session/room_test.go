package session

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"classicy/streamer/internal/fanout"
	"classicy/streamer/internal/model"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"
)

func roomSession(t *testing.T, hub *Hub, room string) *Session {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	s := NewSession(hub, nil, nil, logger)
	s.Init(time.Date(2001, 9, 11, 12, 40, 0, 0, time.UTC), nil)
	if room != "" {
		s.JoinRoom(room)
	}
	hub.mu.Lock()
	hub.sessions[s.id] = s
	hub.mu.Unlock()
	drain(t, s)
	return s
}

func TestJoinAndLeaveRoom(t *testing.T) {
	s := newTestSession(t)
	if s.Room() != "" {
		t.Fatalf("new session room = %q, want empty", s.Room())
	}
	s.JoinRoom("42")
	if s.Room() != "42" {
		t.Fatalf("room = %q, want 42", s.Room())
	}
	s.JoinRoom("43") // joining replaces rather than accumulates
	if s.Room() != "43" {
		t.Fatalf("room = %q, want 43", s.Room())
	}
	s.LeaveRoom()
	if s.Room() != "" {
		t.Fatalf("room after leave = %q, want empty", s.Room())
	}
}

func TestBroadcastRoomReachesOnlyThatRoom(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := NewHub(logger, 0)

	inRoom := roomSession(t, hub, "42")
	otherRoom := roomSession(t, hub, "43")
	noRoom := roomSession(t, hub, "")

	target := time.Date(2001, 9, 11, 13, 3, 0, 0, time.UTC)
	hub.BroadcastRoom(model.RoomCommand{Room: "42", Action: model.RoomActionJump, Time: target})

	m := recvType(t, inRoom)
	if m.Type != "room_command" || m.Action != model.RoomActionJump {
		t.Fatalf("room member got %+v", m)
	}
	if m.Time != target.Format(time.RFC3339) {
		t.Fatalf("jump time = %q, want %q", m.Time, target.Format(time.RFC3339))
	}
	for name, s := range map[string]*Session{"other room": otherRoom, "no room": noRoom} {
		select {
		case <-s.send:
			t.Fatalf("%s session received a command addressed to room 42", name)
		default:
		}
	}
}

// A command with no room must not become a broadcast to everyone not following
// a playlist — the blank field means "unaddressed", not "all".
func TestBroadcastRoomIgnoresBlankRoom(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := NewHub(logger, 0)
	noRoom := roomSession(t, hub, "")
	inRoom := roomSession(t, hub, "42")

	hub.BroadcastRoom(model.RoomCommand{Action: model.RoomActionMessage, Message: "hi"})

	for name, s := range map[string]*Session{"no room": noRoom, "room 42": inRoom} {
		select {
		case <-s.send:
			t.Fatalf("%s session received an unaddressed command", name)
		default:
		}
	}
}

func TestRoomCommandCarriesPerActionPayload(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := NewHub(logger, 0)
	s := roomSession(t, hub, "42")

	hub.BroadcastRoom(model.RoomCommand{Room: "42", Action: model.RoomActionFocus, App: "TV.app"})
	m := recvType(t, s)
	if m.Action != model.RoomActionFocus || m.App != "TV.app" {
		t.Fatalf("focus frame = %+v", m)
	}

	hub.BroadcastRoom(model.RoomCommand{Room: "42", Action: model.RoomActionMessage, Message: "Look at channel 4"})
	m = recvType(t, s)
	if m.Action != model.RoomActionMessage || m.Msg != "Look at channel 4" {
		t.Fatalf("message frame = %+v", m)
	}
}

// The cross-pod claim for room control: a teacher's command issued against one
// pod must reach a student whose socket lives on another.
func TestRoomCommandCrossesPods(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis.Run: %v", err)
	}
	defer mr.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	rdbA := goredis.NewClient(&goredis.Options{Addr: mr.Addr()})
	rdbB := goredis.NewClient(&goredis.Options{Addr: mr.Addr()})
	defer rdbA.Close()
	defer rdbB.Close()

	busA := fanout.New[model.RoomCommand](rdbA, "room:command", logger)

	hubB := NewHub(logger, 0)
	busB := fanout.New[model.RoomCommand](rdbB, "room:command", logger)
	busB.OnMessage(hubB.BroadcastRoom)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go busB.Run(ctx)

	student := roomSession(t, hubB, "42")
	target := time.Date(2001, 9, 11, 13, 3, 0, 0, time.UTC)
	cmd := model.RoomCommand{Room: "42", Action: model.RoomActionJump, Time: target}

	deadline := time.Now().Add(2 * time.Second)
	var got outMsg
	for time.Now().Before(deadline) {
		if err := busA.Publish(ctx, cmd); err != nil {
			t.Fatalf("publish from pod A: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
		select {
		case data := <-student.send:
			got = decodeFrame(t, data)
		default:
			continue
		}
		break
	}

	if got.Type != "room_command" || got.Action != model.RoomActionJump {
		t.Fatalf("student on pod B never got the command (frame %q)", got.Type)
	}
	if got.Time != target.Format(time.RFC3339) {
		t.Fatalf("jump time = %q, want %q", got.Time, target.Format(time.RFC3339))
	}
}

// A member session receives a reload relay like any other room command — the
// frame carries the action alone, since the definition is re-fetched from
// Directus by the client rather than relayed.
func TestBroadcastRoomRelaysReload(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := NewHub(logger, 0)
	s := roomSession(t, hub, "42")

	hub.BroadcastRoom(model.RoomCommand{Room: "42", Action: model.RoomActionReload})
	m := recvType(t, s)
	if m.Type != "room_command" || m.Action != model.RoomActionReload {
		t.Fatalf("reload frame = %+v", m)
	}
	if m.Time != "" || m.App != "" || m.Msg != "" || m.Target != "" || m.On != nil {
		t.Fatalf("reload frame carries payload it must not: %+v", m)
	}
}

// The catch-up path: a student who joins AFTER the teacher jumped, locked, and
// pushed a definition update must still converge. The hub replays the room's
// last-known state on join, in application order (jump, lock, reload), and
// does NOT replay transient actions (focus/message) whose moment has passed.
func TestJoinReplaysLastKnownRoomState(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := NewHub(logger, 0)

	target := time.Date(2001, 9, 11, 13, 3, 0, 0, time.UTC)
	hub.BroadcastRoom(model.RoomCommand{Room: "42", Action: model.RoomActionJump, Time: target})
	hub.BroadcastRoom(model.RoomCommand{Room: "42", Action: model.RoomActionLock, Target: model.RoomLockClock, On: true})
	hub.BroadcastRoom(model.RoomCommand{Room: "42", Action: model.RoomActionMessage, Message: "already said"})
	hub.BroadcastRoom(model.RoomCommand{Room: "42", Action: model.RoomActionFocus, App: "TV.app"})
	hub.BroadcastRoom(model.RoomCommand{Room: "42", Action: model.RoomActionReload})

	logger2 := slog.New(slog.NewTextHandler(io.Discard, nil))
	s := NewSession(hub, nil, nil, logger2)
	s.Init(time.Date(2001, 9, 11, 12, 40, 0, 0, time.UTC), nil)
	drain(t, s)
	s.JoinRoom("42")

	jump := recvType(t, s)
	if jump.Action != model.RoomActionJump || jump.Time != target.Format(time.RFC3339) {
		t.Fatalf("first replayed frame = %+v, want the jump", jump)
	}
	lock := recvType(t, s)
	if lock.Action != model.RoomActionLock || lock.Target != model.RoomLockClock {
		t.Fatalf("second replayed frame = %+v, want the lock", lock)
	}
	if lock.On == nil || !*lock.On {
		t.Fatalf("replayed lock on = %v, want true", lock.On)
	}
	reload := recvType(t, s)
	if reload.Action != model.RoomActionReload {
		t.Fatalf("third replayed frame = %+v, want the reload", reload)
	}
	select {
	case data := <-s.send:
		t.Fatalf("transient action replayed to a late joiner: %+v", decodeFrame(t, data))
	default:
	}
}

// Only the LAST jump is state; replaying a history of jumps would drag a late
// joiner through every place the class has been.
func TestJoinReplaysOnlyTheLatestJump(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := NewHub(logger, 0)

	first := time.Date(2001, 9, 11, 12, 46, 0, 0, time.UTC)
	last := time.Date(2001, 9, 11, 13, 3, 0, 0, time.UTC)
	hub.BroadcastRoom(model.RoomCommand{Room: "42", Action: model.RoomActionJump, Time: first})
	hub.BroadcastRoom(model.RoomCommand{Room: "42", Action: model.RoomActionJump, Time: last})

	s := NewSession(hub, nil, nil, logger)
	s.JoinRoom("42")
	m := recvType(t, s)
	if m.Time != last.Format(time.RFC3339) {
		t.Fatalf("replayed jump time = %q, want the latest (%q)", m.Time, last.Format(time.RFC3339))
	}
	select {
	case data := <-s.send:
		t.Fatalf("more than one jump replayed: %+v", decodeFrame(t, data))
	default:
	}
}

// An unlock is state too: the last lock command wins whatever its value, so a
// joiner after lock-then-unlock sees on:false, not a stale lock.
func TestJoinReplaysUnlockAfterLock(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := NewHub(logger, 0)
	hub.BroadcastRoom(model.RoomCommand{Room: "42", Action: model.RoomActionLock, Target: model.RoomLockClock, On: true})
	hub.BroadcastRoom(model.RoomCommand{Room: "42", Action: model.RoomActionLock, Target: model.RoomLockClock, On: false})

	s := NewSession(hub, nil, nil, logger)
	s.JoinRoom("42")
	m := recvType(t, s)
	if m.Action != model.RoomActionLock || m.On == nil || *m.On {
		t.Fatalf("replayed lock = %+v, want on:false", m)
	}
}

// Rooms are isolated: joining an untouched room replays nothing, and another
// room's state never leaks into this one's replay.
func TestJoinReplaysNothingForAnUntouchedRoom(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := NewHub(logger, 0)
	hub.BroadcastRoom(model.RoomCommand{Room: "43", Action: model.RoomActionReload})

	s := NewSession(hub, nil, nil, logger)
	s.JoinRoom("42")
	select {
	case data := <-s.send:
		t.Fatalf("untouched room replayed a frame: %+v", decodeFrame(t, data))
	default:
	}
	s.LeaveRoom() // leaving must not replay either
	select {
	case data := <-s.send:
		t.Fatalf("leaving replayed a frame: %+v", decodeFrame(t, data))
	default:
	}
}

// The cross-pod claim for the catch-up path: state recorded from the fanout bus
// on pod B must be replayed to a student who joins on pod B, even though the
// command was published from pod A and no member was connected when it landed.
func TestJoinAfterCrossPodCommandReplaysState(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis.Run: %v", err)
	}
	defer mr.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	rdbA := goredis.NewClient(&goredis.Options{Addr: mr.Addr()})
	rdbB := goredis.NewClient(&goredis.Options{Addr: mr.Addr()})
	defer rdbA.Close()
	defer rdbB.Close()

	busA := fanout.New[model.RoomCommand](rdbA, "room:command", logger)
	hubB := NewHub(logger, 0)
	busB := fanout.New[model.RoomCommand](rdbB, "room:command", logger)
	busB.OnMessage(hubB.BroadcastRoom)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go busB.Run(ctx)

	cmd := model.RoomCommand{Room: "42", Action: model.RoomActionReload}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if err := busA.Publish(ctx, cmd); err != nil {
			t.Fatalf("publish from pod A: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
		if len(hubB.RoomState("42")) > 0 {
			break
		}
	}
	if len(hubB.RoomState("42")) == 0 {
		t.Fatal("pod B never recorded the cross-pod command")
	}

	student := NewSession(hubB, nil, nil, logger)
	student.JoinRoom("42")
	m := recvType(t, student)
	if m.Type != "room_command" || m.Action != model.RoomActionReload {
		t.Fatalf("late joiner on pod B got %+v, want the reload replay", m)
	}
}

// The lock frame must carry `on` in both directions. It rides a *bool in outMsg
// precisely because an unlock is `false`, which plain omitempty would drop —
// leaving the client unable to tell "unlock" from "no lock field at all".
func TestRoomLockFrameTransmitsBothStates(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := NewHub(logger, 0)
	s := roomSession(t, hub, "42")

	hub.BroadcastRoom(model.RoomCommand{
		Room: "42", Action: model.RoomActionLock, Target: model.RoomLockClock, On: true,
	})
	m := recvType(t, s)
	if m.Action != model.RoomActionLock || m.Target != model.RoomLockClock {
		t.Fatalf("lock frame = %+v", m)
	}
	if m.On == nil || !*m.On {
		t.Fatalf("lock on: got %v, want true", m.On)
	}

	hub.BroadcastRoom(model.RoomCommand{
		Room: "42", Action: model.RoomActionLock, Target: model.RoomLockClock, On: false,
	})
	m = recvType(t, s)
	if m.On == nil {
		t.Fatal("unlock dropped `on` from the frame; the client cannot tell unlock from absent")
	}
	if *m.On {
		t.Fatalf("unlock on: got %v, want false", *m.On)
	}
}
