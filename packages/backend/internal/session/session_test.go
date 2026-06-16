package session

import (
	"bytes"
	"io"
	"log/slog"
	"testing"
	"time"

	"classicy/streamer/internal/model"

	"github.com/vmihailenco/msgpack/v5"
)

func newTestSession(t *testing.T) *Session {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := NewHub(logger)
	return NewSession(hub, nil, logger)
}

// recvType drains one queued outbound message and returns its decoded envelope.
func recvType(t *testing.T, s *Session) outMsg {
	t.Helper()
	select {
	case data := <-s.send:
		var m outMsg
		dec := msgpack.NewDecoder(bytes.NewReader(data))
		dec.SetCustomStructTag("json")
		if err := dec.Decode(&m); err != nil {
			t.Fatalf("decode outbound: %v", err)
		}
		return m
	default:
		t.Fatal("expected an outbound message, got none")
		return outMsg{}
	}
}

func TestSubscribeUnsubscribePagerChannel(t *testing.T) {
	s := newTestSession(t)

	if s.Subscribed(ChannelPager) {
		t.Fatal("new session should not be subscribed to pager")
	}

	s.Subscribe(ChannelPager)
	if !s.Subscribed(ChannelPager) {
		t.Fatal("expected pager subscription after Subscribe")
	}
	if ack := recvType(t, s); ack.Type != "subscribe_ack" || ack.Channel != ChannelPager {
		t.Fatalf("expected subscribe_ack for pager, got %+v", ack)
	}

	s.Unsubscribe(ChannelPager)
	if s.Subscribed(ChannelPager) {
		t.Fatal("expected no pager subscription after Unsubscribe")
	}
	if ack := recvType(t, s); ack.Type != "unsubscribe_ack" || ack.Channel != ChannelPager {
		t.Fatalf("expected unsubscribe_ack for pager, got %+v", ack)
	}
}

func TestSendMp3EmitsFrameWithMediaItems(t *testing.T) {
	s := newTestSession(t)
	at := time.Date(2001, 9, 11, 15, 26, 0, 0, time.UTC)

	s.SendMp3(at, []model.MediaItem{{ID: 5821, Title: "ID Rountree", Format: "mp3", URL: "x.mp3"}})

	m := recvType(t, s)
	if m.Type != "mp3" {
		t.Fatalf("expected mp3 frame, got %q", m.Type)
	}
	if len(m.Items) != 1 || m.Items[0].Title != "ID Rountree" {
		t.Fatalf("expected one mp3 media item, got %+v", m.Items)
	}
	if len(m.Pager) != 0 {
		t.Fatalf("mp3 frame must not carry pager payload, got %+v", m.Pager)
	}
}

func TestMp3ChannelIndependentOfPager(t *testing.T) {
	s := newTestSession(t)
	s.Subscribe(ChannelMp3)
	_ = recvType(t, s) // drain subscribe_ack
	if !s.Subscribed(ChannelMp3) {
		t.Fatal("expected mp3 subscription")
	}
	if s.Subscribed(ChannelPager) {
		t.Fatal("subscribing mp3 must not subscribe pager")
	}
}

func TestSendNewsEmitsFrameWithMediaItems(t *testing.T) {
	s := newTestSession(t)
	at := time.Date(2001, 9, 11, 13, 30, 0, 0, time.UTC)

	s.SendNews(at, []model.MediaItem{{ID: 9001, Title: "Headline", Format: "news"}})

	m := recvType(t, s)
	if m.Type != "news" {
		t.Fatalf("expected news frame, got %q", m.Type)
	}
	if len(m.Items) != 1 || m.Items[0].Title != "Headline" {
		t.Fatalf("expected one news media item, got %+v", m.Items)
	}
}

func TestChannelsAreIndependent(t *testing.T) {
	s := newTestSession(t)
	s.Subscribe(ChannelNews)
	_ = recvType(t, s) // drain subscribe_ack
	if !s.Subscribed(ChannelNews) {
		t.Fatal("expected news subscription")
	}
	if s.Subscribed(ChannelMp3) || s.Subscribed(ChannelPager) {
		t.Fatal("subscribing news must not subscribe mp3 or pager")
	}
}

func TestSendPagerEmptyBatchSendsNothing(t *testing.T) {
	s := newTestSession(t)

	s.SendPager(time.Now(), nil)
	select {
	case <-s.send:
		t.Fatal("empty pager batch must not produce a frame")
	default:
	}
}

func TestSendPagerEmitsFrame(t *testing.T) {
	s := newTestSession(t)
	at := time.Date(2001, 9, 11, 12, 46, 0, 0, time.UTC)

	s.SendPager(at, []model.PagerItem{{ID: 1, Message: "page one", StartDate: at}})

	m := recvType(t, s)
	if m.Type != "pager" {
		t.Fatalf("expected pager frame, got %q", m.Type)
	}
	if len(m.Pager) != 1 || m.Pager[0].Message != "page one" {
		t.Fatalf("expected one pager item 'page one', got %+v", m.Pager)
	}
	if m.Time != at.Format(time.RFC3339) {
		t.Fatalf("expected time %s, got %s", at.Format(time.RFC3339), m.Time)
	}
}

func TestVirtualTimeNotReadyBeforeInit(t *testing.T) {
	s := newTestSession(t)
	if _, ok := s.VirtualTime(); ok {
		t.Fatal("virtual time should not be ready before init")
	}

	at := time.Date(2001, 9, 11, 8, 46, 0, 0, time.UTC)
	s.Init(at, nil)
	got, ok := s.VirtualTime()
	if !ok || !got.Equal(at) {
		t.Fatalf("expected virtual time %s ready, got %s ok=%v", at, got, ok)
	}
}
