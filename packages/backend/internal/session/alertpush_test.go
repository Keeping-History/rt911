package session

import (
	"testing"
	"time"

	"classicy/streamer/internal/model"
)

func testAlert(id int, start time.Time) model.AlertItem {
	sev := "caution"
	return model.AlertItem{
		MediaItem: model.MediaItem{ID: id, Title: "Ground stop", StartDate: start},
		Severity:  &sev,
	}
}

// The restamp is the whole point of the push path: the client reveal-gates
// alerts by start_date against its own virtual clock, so an alert scheduled for
// a different instant has to arrive carrying *this* session's time or it lands
// in the future buffer and never shows.
func TestPushAlertRestampsToSessionVirtualTime(t *testing.T) {
	s := newTestSession(t)
	vt := time.Date(2001, 9, 11, 13, 3, 0, 0, time.UTC)
	s.Init(vt, nil)
	s.Subscribe(ChannelAlerts)
	drain(t, s)

	scheduled := time.Date(2001, 9, 11, 20, 0, 0, 0, time.UTC) // hours later
	s.PushAlert(testAlert(42, scheduled))

	m := recvType(t, s)
	if m.Type != "alerts" {
		t.Fatalf("got frame %q, want alerts", m.Type)
	}
	if len(m.Alerts) != 1 {
		t.Fatalf("got %d alerts, want 1", len(m.Alerts))
	}
	if !m.Alerts[0].StartDate.Equal(vt) {
		t.Fatalf("start_date: got %v, want the session's virtual time %v", m.Alerts[0].StartDate, vt)
	}
	if m.Alerts[0].ID != 42 || m.Alerts[0].Severity == nil || *m.Alerts[0].Severity != "caution" {
		t.Fatalf("push mangled the alert: %+v", m.Alerts[0])
	}
	if m.Time != vt.Format(time.RFC3339) {
		t.Fatalf("frame time: got %q, want %q", m.Time, vt.Format(time.RFC3339))
	}
}

func TestPushAlertIgnoredWhenNotSubscribed(t *testing.T) {
	s := newTestSession(t)
	s.Init(time.Date(2001, 9, 11, 13, 3, 0, 0, time.UTC), nil)
	drain(t, s)

	s.PushAlert(testAlert(1, time.Now().UTC()))

	select {
	case <-s.send:
		t.Fatal("unsubscribed session received an alert push")
	default:
	}
}

// Before Init the session has no virtual time to stamp with, so a push has no
// meaningful "now" to claim — it must drop rather than send a zero-time frame.
func TestPushAlertIgnoredBeforeInit(t *testing.T) {
	s := newTestSession(t)
	s.Subscribe(ChannelAlerts)
	drain(t, s)

	s.PushAlert(testAlert(1, time.Now().UTC()))

	select {
	case <-s.send:
		t.Fatal("uninitialised session received an alert push")
	default:
	}
}

func TestBroadcastAlertReachesOnlySubscribedSessions(t *testing.T) {
	sub := newTestSession(t)
	hub := sub.hub
	vt := time.Date(2001, 9, 11, 13, 3, 0, 0, time.UTC)
	sub.Init(vt, nil)
	sub.Subscribe(ChannelAlerts)

	// A second session on the same hub that never opted in.
	unsub := NewSession(hub, nil, nil, sub.logger)
	unsub.Init(vt, nil)

	// Register synchronously — Run isn't going in tests.
	hub.mu.Lock()
	hub.sessions[sub.id] = sub
	hub.sessions[unsub.id] = unsub
	hub.mu.Unlock()

	drain(t, sub)
	drain(t, unsub)

	hub.BroadcastAlert(testAlert(7, time.Date(2001, 9, 11, 20, 0, 0, 0, time.UTC)))

	m := recvType(t, sub)
	if m.Type != "alerts" || len(m.Alerts) != 1 || m.Alerts[0].ID != 7 {
		t.Fatalf("subscribed session got %+v", m)
	}
	select {
	case <-unsub.send:
		t.Fatal("unsubscribed session received the broadcast")
	default:
	}
}
