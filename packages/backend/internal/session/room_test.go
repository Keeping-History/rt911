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
