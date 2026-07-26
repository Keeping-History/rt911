package session

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"classicy/streamer/internal/chat"
	"classicy/streamer/internal/clock"
	"classicy/streamer/internal/model"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"
	"github.com/vmihailenco/msgpack/v5"
)

func newTestSession(t *testing.T) *Session {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := NewHub(logger, 0)
	return NewSession(hub, nil, nil, logger)
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

// drain discards frames emitted as a side effect of setup so a test asserts on
// the frame it actually triggered.
func drain(t *testing.T, s *Session) {
	t.Helper()
	for {
		select {
		case <-s.send:
		default:
			return
		}
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

func TestSendMp3HistoryEmitsFrameWithMediaItems(t *testing.T) {
	s := newTestSession(t)
	at := time.Date(2001, 9, 11, 15, 26, 0, 0, time.UTC)

	s.SendMp3History(at, []model.MediaItem{
		{ID: 5801, Title: "ATC 0834", Format: "mp3", URL: "a.mp3"},
		{ID: 5810, Title: "ATC 0851", Format: "mp3", URL: "b.mp3"},
	})

	m := recvType(t, s)
	if m.Type != "mp3_history" {
		t.Fatalf("expected mp3_history frame, got %q", m.Type)
	}
	if len(m.Items) != 2 || m.Items[0].Title != "ATC 0834" {
		t.Fatalf("expected two mp3 history items, got %+v", m.Items)
	}
}

func TestSendMp3HistorySendsEmptyBatch(t *testing.T) {
	// Unlike SendMp3, an empty history frame must still be sent — the client
	// replaces its history wholesale, and an empty frame is what clears state
	// after a seek to before the first recording.
	s := newTestSession(t)
	at := time.Date(2001, 9, 11, 10, 0, 0, 0, time.UTC)

	s.SendMp3History(at, nil)

	m := recvType(t, s)
	if m.Type != "mp3_history" {
		t.Fatalf("expected mp3_history frame, got %q", m.Type)
	}
	if len(m.Items) != 0 {
		t.Fatalf("expected empty items, got %+v", m.Items)
	}
}

func TestSendSourcesEmitsSourceLists(t *testing.T) {
	s := newTestSession(t)

	s.SendSources(
		[]string{"BBC", "CNN", "WETA"},
		[]string{"ATC", "Rutgers"},
		[]string{"Arch", "Skytel"},
		[]model.NewsgroupSource{{Name: "ntl.support.modems", Count: 5}},
	)

	m := recvType(t, s)
	if m.Type != "sources" {
		t.Fatalf("expected sources frame, got %q", m.Type)
	}
	if m.Sources == nil {
		t.Fatal("expected sources payload, got nil")
	}
	if len(m.Sources.Video) != 3 || m.Sources.Video[0] != "BBC" {
		t.Fatalf("unexpected video sources: %+v", m.Sources.Video)
	}
	if len(m.Sources.Audio) != 2 || m.Sources.Audio[0] != "ATC" {
		t.Fatalf("unexpected audio sources: %+v", m.Sources.Audio)
	}
	if len(m.Sources.Pager) != 2 || m.Sources.Pager[1] != "Skytel" {
		t.Fatalf("unexpected pager providers: %+v", m.Sources.Pager)
	}
	if len(m.Sources.Usenet) != 1 || m.Sources.Usenet[0].Name != "ntl.support.modems" || m.Sources.Usenet[0].Count != 5 {
		t.Fatalf("unexpected usenet newsgroups: %+v", m.Sources.Usenet)
	}
	if len(m.Items) != 0 || len(m.Pager) != 0 {
		t.Fatalf("sources frame must not carry item payloads, got items=%+v pager=%+v", m.Items, m.Pager)
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

func TestInitResetsAllHorizons(t *testing.T) {
	s := newTestSession(t)
	at := time.Date(2001, 9, 11, 8, 46, 0, 0, time.UTC)
	s.Init(at, nil)
	_ = recvType(t, s) // drain init_ack

	if !s.mediaHorizon.Equal(at) || !s.pagerHorizon.Equal(at) ||
		!s.mp3Horizon.Equal(at) || !s.newsHorizon.Equal(at) {
		t.Fatalf("Init must reset every horizon to t; got media=%v pager=%v mp3=%v news=%v",
			s.mediaHorizon, s.pagerHorizon, s.mp3Horizon, s.newsHorizon)
	}
}

func TestPlanRefillWindowsAreHalfOpenContiguousAndLeadTriggered(t *testing.T) {
	base := time.Date(2001, 9, 11, 8, 46, 0, 0, time.UTC)
	horizon := base // freshly init'd to t

	// First tick after init (vTime = base+1s): clock is within leadSeconds of the
	// horizon, so a refill is due covering [horizon, vTime+window).
	v := base.Add(1 * time.Second)
	lo, hi, due := planRefill(&horizon, v, windowMedia)
	if !due {
		t.Fatal("first tick after init must refill")
	}
	if !lo.Equal(base) {
		t.Fatalf("lo must be the old horizon (base), got %v", lo)
	}
	if !hi.Equal(v.Add(windowMedia)) {
		t.Fatalf("hi must be vTime+window, got %v", hi)
	}
	if !horizon.Equal(hi) {
		t.Fatalf("horizon must advance to hi, got %v", horizon)
	}

	// A tick deep inside the buffered window is a no-op (no Redis lookup).
	if _, _, due := planRefill(&horizon, base.Add(2*time.Second), windowMedia); due {
		t.Fatal("a tick well inside the window must not refill")
	}

	// Once the clock comes within leadSeconds of the horizon, the next refill
	// fires and its lower edge equals the previous upper edge — contiguous, no gap
	// and no overlap.
	prevHi := horizon
	atLead := horizon.Add(-leadSeconds) // vTime+lead == horizon (boundary)
	lo2, _, due := planRefill(&horizon, atLead, windowMedia)
	if !due {
		t.Fatal("refill must fire at the lead boundary")
	}
	if !lo2.Equal(prevHi) {
		t.Fatalf("windows must be contiguous: lo2=%v != prevHi=%v", lo2, prevHi)
	}
}

// TestWindowingCutsLookupFrequency characterizes the scaling win: over a virtual
// hour, a single session issues ~one Redis lookup per (window − lead) seconds
// instead of one per second. This is the per-session multiplier behind the
// per-tick burst flattening at thousands of spread sessions.
func TestWindowingCutsLookupFrequency(t *testing.T) {
	base := time.Date(2001, 9, 11, 8, 46, 0, 0, time.UTC)
	horizon := base // freshly init'd
	const ticks = 3600

	refills, v := 0, base
	for i := 0; i < ticks; i++ {
		v = v.Add(time.Second)
		if _, _, due := planRefill(&horizon, v, windowMedia); due {
			refills++
		}
	}

	// windowMedia=300s, lead=30s → refill cadence ≈ 270s → ~14 refills/hour,
	// vs 3600 per-second lookups: ~250× fewer Redis ops (≈ window×).
	if refills < 10 || refills > 20 {
		t.Fatalf("expected ~14 windowed refills over %d ticks, got %d (cadence regression)", ticks, refills)
	}
	t.Logf("windowing: %d refills over %d ticks — %.0f× fewer Redis lookups than per-second",
		refills, ticks, float64(ticks)/float64(refills))
}

func TestPlanChannelRefillRequiresSubscription(t *testing.T) {
	s := newTestSession(t)
	base := time.Date(2001, 9, 11, 12, 46, 0, 0, time.UTC)
	s.pagerHorizon = base
	v := base.Add(1 * time.Second)

	// Unsubscribed: never refills, even when the clock is at the horizon.
	if _, _, due := s.planChannelRefill(ChannelPager, &s.pagerHorizon, v, windowPager); due {
		t.Fatal("an unsubscribed channel must never refill")
	}

	s.Subscribe(ChannelPager)
	_ = recvType(t, s)    // drain subscribe_ack
	s.pagerHorizon = base // Subscribe reset it to virtualTime (zero, not init'd)
	if _, _, due := s.planChannelRefill(ChannelPager, &s.pagerHorizon, v, windowPager); !due {
		t.Fatal("a subscribed channel at its horizon must refill")
	}
}

func TestSendUsenetEmitsFrameWithUsenetItems(t *testing.T) {
	s := newTestSession(t)
	at := time.Date(2001, 9, 11, 9, 0, 0, 0, time.UTC)

	s.SendUsenet(at, []model.UsenetItem{{ID: 7001, Newsgroup: "ntl.talk", Subject: "Re: hi", ThreadID: "<root@x>"}})

	m := recvType(t, s)
	if m.Type != "usenet" {
		t.Fatalf("expected usenet frame, got %q", m.Type)
	}
	if len(m.Usenet) != 1 || m.Usenet[0].Subject != "Re: hi" || m.Usenet[0].Newsgroup != "ntl.talk" {
		t.Fatalf("expected one usenet item, got %+v", m.Usenet)
	}
	if len(m.Items) != 0 || len(m.Pager) != 0 {
		t.Fatalf("usenet frame must not carry other payloads, got items=%+v pager=%+v", m.Items, m.Pager)
	}
}

// SendUsenet suppresses empty batches, exactly like the other channel sends.
func TestSendUsenetSuppressesEmptyBatch(t *testing.T) {
	s := newTestSession(t)
	s.SendUsenet(time.Now(), nil)
	select {
	case <-s.send:
		t.Fatal("empty usenet batch must not emit a frame")
	default:
	}
}

func TestSetUsenetGroupsTracksActiveAndAcks(t *testing.T) {
	s := newTestSession(t)

	s.SetUsenetGroups([]string{"ntl.support.modems", "", "ntl.talk"})
	if ack := recvType(t, s); ack.Type != "usenet_filter_ack" {
		t.Fatalf("expected usenet_filter_ack, got %+v", ack)
	}
	groups := s.ActiveUsenetGroups()
	if len(groups) != 2 { // empty name dropped
		t.Fatalf("expected 2 active groups, got %+v", groups)
	}

	// Selecting an empty set means "view nothing" — the channel then delivers none.
	s.SetUsenetGroups(nil)
	_ = recvType(t, s) // drain ack
	if g := s.ActiveUsenetGroups(); len(g) != 0 {
		t.Fatalf("expected no active groups after clearing, got %+v", g)
	}
}

// SendUsenetBody emits the single-body frame with id + body, no other payload.
func TestSendUsenetBodyEmitsBodyFrame(t *testing.T) {
	s := newTestSession(t)

	s.SendUsenetBody(7001, "Hello, world.\n", "")

	m := recvType(t, s)
	if m.Type != "usenet_body" {
		t.Fatalf("expected usenet_body frame, got %q", m.Type)
	}
	if m.ID != 7001 || m.Body != "Hello, world.\n" {
		t.Fatalf("unexpected body frame: id=%d body=%q", m.ID, m.Body)
	}
	if m.Msg != "" {
		t.Fatalf("success frame must not carry an error message, got %q", m.Msg)
	}
	if len(m.Usenet) != 0 || len(m.Items) != 0 {
		t.Fatalf("body frame must not carry list payloads, got usenet=%+v items=%+v", m.Usenet, m.Items)
	}
}

// On failure the frame carries the error message and an empty body, so the
// client can distinguish "unavailable" from a genuinely empty body.
func TestSendUsenetBodyEmitsErrorFrame(t *testing.T) {
	s := newTestSession(t)

	s.SendUsenetBody(7002, "", "message unavailable")

	m := recvType(t, s)
	if m.Type != "usenet_body" || m.ID != 7002 {
		t.Fatalf("unexpected frame: %+v", m)
	}
	if m.Body != "" || m.Msg != "message unavailable" {
		t.Fatalf("expected empty body + error message, got body=%q msg=%q", m.Body, m.Msg)
	}
}

// An unsubscribed usenet channel never refills, even with active groups selected.
func TestUsenetRefillRequiresSubscription(t *testing.T) {
	s := newTestSession(t)
	v := time.Date(2001, 9, 20, 12, 0, 0, 0, time.UTC)
	s.virtualTime = v
	s.SetUsenetGroups([]string{"ntl.talk"})
	_ = recvType(t, s) // drain ack

	s.usenetHorizon = v
	if _, _, due := s.planChannelRefill(ChannelUsenet, &s.usenetHorizon, v, windowUsenet); due {
		t.Fatal("usenet must not refill without a subscription")
	}

	s.Subscribe(ChannelUsenet)
	_ = recvType(t, s) // drain subscribe_ack
	s.usenetHorizon = v
	if _, _, due := s.planChannelRefill(ChannelUsenet, &s.usenetHorizon, v, windowUsenet); !due {
		t.Fatal("a subscribed usenet channel at its horizon must refill")
	}
}

func TestSeekResetsHorizonsAndEmitsAck(t *testing.T) {
	s := newTestSession(t)
	base := time.Date(2001, 9, 11, 8, 46, 0, 0, time.UTC)
	seek := base.Add(30 * time.Minute)

	s.Init(base, nil)
	_ = recvType(t, s) // drain init_ack

	s.Seek(seek, []model.MediaItem{{ID: 1, Title: "x", Approved: 1, StartDate: seek}})

	m := recvType(t, s)
	if m.Type != "seek_ack" {
		t.Fatalf("expected seek_ack, got %q", m.Type)
	}
	if m.Time != seek.Format(time.RFC3339) {
		t.Fatalf("seek_ack time: want %s, got %s", seek.Format(time.RFC3339), m.Time)
	}
	if len(m.Items) != 1 || m.Items[0].ID != 1 {
		t.Fatalf("seek_ack must carry items, got %+v", m.Items)
	}

	s.mu.Lock()
	allReset := s.mediaHorizon.Equal(seek) && s.pagerHorizon.Equal(seek) &&
		s.mp3Horizon.Equal(seek) && s.newsHorizon.Equal(seek) && s.usenetHorizon.Equal(seek)
	s.mu.Unlock()
	if !allReset {
		t.Fatal("Seek must reset every channel horizon to the new virtual time")
	}
}

func TestPauseEmitsPauseAck(t *testing.T) {
	s := newTestSession(t)
	s.Pause()

	if m := recvType(t, s); m.Type != "pause_ack" {
		t.Fatalf("expected pause_ack, got %q", m.Type)
	}
	s.mu.Lock()
	paused := s.paused
	s.mu.Unlock()
	if !paused {
		t.Fatal("Pause must set paused=true")
	}
}

func TestResumeAfterPauseEmitsResumeAck(t *testing.T) {
	s := newTestSession(t)
	s.Pause()
	_ = recvType(t, s) // drain pause_ack

	s.Resume()

	if m := recvType(t, s); m.Type != "resume_ack" {
		t.Fatalf("expected resume_ack, got %q", m.Type)
	}
	s.mu.Lock()
	paused := s.paused
	s.mu.Unlock()
	if paused {
		t.Fatal("Resume must clear paused")
	}
}

func TestHeartbeatWithinDriftDoesNotCorrect(t *testing.T) {
	s := newTestSession(t)
	base := time.Date(2001, 9, 11, 8, 46, 0, 0, time.UTC)
	s.Init(base, nil)
	_ = recvType(t, s) // drain init_ack

	// 1s drift is below driftThresh (3s) — virtual time must not change.
	s.Heartbeat(base.Add(time.Second))
	_ = recvType(t, s) // drain heartbeat_ack

	if got, _ := s.VirtualTime(); !got.Equal(base) {
		t.Fatalf("small drift must not correct virtual time: want %v, got %v", base, got)
	}
}

func TestHeartbeatExceedingDriftCorrects(t *testing.T) {
	s := newTestSession(t)
	base := time.Date(2001, 9, 11, 8, 46, 0, 0, time.UTC)
	s.Init(base, nil)
	_ = recvType(t, s) // drain init_ack

	// 10s drift exceeds driftThresh (3s) — virtual time must snap to clientTime.
	clientTime := base.Add(10 * time.Second)
	s.Heartbeat(clientTime)

	if m := recvType(t, s); m.Type != "heartbeat_ack" {
		t.Fatalf("expected heartbeat_ack, got %q", m.Type)
	}
	if got, _ := s.VirtualTime(); !got.Equal(clientTime) {
		t.Fatalf("large drift must correct virtual time: want %v, got %v", clientTime, got)
	}
}

func TestSetFormatFilterFiltersItems(t *testing.T) {
	s := newTestSession(t)
	s.SetFormatFilter([]string{"m3u8"})
	_ = recvType(t, s) // drain filter_ack

	items := []model.MediaItem{
		{ID: 1, Format: "m3u8", Approved: 1},
		{ID: 2, Format: "mp4", Approved: 1},
		{ID: 3, Format: "m3u8", Approved: 1},
	}
	got := s.applyFormatFilter(items)
	if len(got) != 2 || got[0].ID != 1 || got[1].ID != 3 {
		t.Fatalf("filter(m3u8): expected ids [1,3], got %+v", got)
	}
}

func TestSetFormatFilterNilAllowsAll(t *testing.T) {
	s := newTestSession(t)
	s.SetFormatFilter([]string{"m3u8"})
	_ = recvType(t, s)

	s.SetFormatFilter(nil)
	_ = recvType(t, s)

	items := []model.MediaItem{
		{ID: 1, Format: "m3u8", Approved: 1},
		{ID: 2, Format: "mp4", Approved: 1},
	}
	if got := s.applyFormatFilter(items); len(got) != 2 {
		t.Fatalf("nil filter must pass all items, got %+v", got)
	}
}

func TestSendErrorEmitsErrorFrame(t *testing.T) {
	s := newTestSession(t)
	s.SendError("something went wrong")

	m := recvType(t, s)
	if m.Type != "error" {
		t.Fatalf("expected error frame, got %q", m.Type)
	}
	if m.Msg != "something went wrong" {
		t.Fatalf("expected error message, got %q", m.Msg)
	}
}

func TestCloseIsIdempotent(t *testing.T) {
	s := newTestSession(t)

	// Multiple Close calls must not panic.
	s.Close()
	s.Close()
	s.Close()

	select {
	case <-s.Done():
	default:
		t.Fatal("Done() channel must be closed after Close()")
	}
}

// TestSendToClosedSessionDropsMessage verifies send_ on a closed session
// does not block or panic — the done guard in send_ must fire first.
func TestSendToClosedSessionDropsMessage(t *testing.T) {
	s := newTestSession(t)
	s.Close()
	s.SendError("after close") // must not panic or block
}

func TestSendFlightsEmitsFrameWithPositions(t *testing.T) {
	s := newTestSession(t)
	at := time.Date(2001, 9, 11, 12, 46, 0, 0, time.UTC)

	s.SendFlights(at, []model.FlightPosition{
		{ID: 1, Flight: "AA11", Carrier: "AA", StartDate: at, Lat: 40.7, Lon: -74.0, AltFt: 29000, Phase: "enroute"},
	})

	m := recvType(t, s)
	if m.Type != "flights" {
		t.Fatalf("expected flights frame, got %q", m.Type)
	}
	if len(m.Flights) != 1 || m.Flights[0].Flight != "AA11" || m.Flights[0].AltFt != 29000 {
		t.Fatalf("expected one flight position, got %+v", m.Flights)
	}
	if len(m.Items) != 0 || len(m.Pager) != 0 {
		t.Fatalf("flights frame must not carry items/pager payloads, got %+v", m)
	}
}

func TestSendFlightsSuppressesEmptyBatch(t *testing.T) {
	s := newTestSession(t)
	s.SendFlights(time.Date(2001, 9, 11, 3, 0, 0, 0, time.UTC), nil)

	select {
	case data := <-s.send:
		t.Fatalf("expected no frame for empty flights batch, got %d bytes", len(data))
	default:
	}
}

func TestFlightsHorizonResetOnSubscribeInitAndSeek(t *testing.T) {
	s := newTestSession(t)
	t0 := time.Date(2001, 9, 11, 12, 40, 0, 0, time.UTC)

	s.Init(t0, nil)
	if !s.flightsHorizon.Equal(t0) {
		t.Fatalf("Init must reset flightsHorizon to t, got %v", s.flightsHorizon)
	}

	s.Subscribe(ChannelFlights)
	if !s.Subscribed(ChannelFlights) {
		t.Fatal("expected flights subscription after Subscribe")
	}

	t1 := t0.Add(2 * time.Hour)
	s.Seek(t1, nil)
	if !s.flightsHorizon.Equal(t1) {
		t.Fatalf("Seek must reset flightsHorizon to t, got %v", s.flightsHorizon)
	}
}

func TestFlightsRefillRequiresSubscription(t *testing.T) {
	s := newTestSession(t)
	t0 := time.Date(2001, 9, 11, 12, 40, 0, 0, time.UTC)
	s.mu.Lock()
	s.virtualTime = t0
	s.flightsHorizon = t0
	if _, _, due := s.planChannelRefill(ChannelFlights, &s.flightsHorizon, t0, windowFlights); due {
		s.mu.Unlock()
		t.Fatal("unsubscribed flights channel must never refill")
	}
	s.mu.Unlock()

	s.Subscribe(ChannelFlights)
	s.mu.Lock()
	lo, hi, due := s.planChannelRefill(ChannelFlights, &s.flightsHorizon, t0, windowFlights)
	s.mu.Unlock()
	if !due || !lo.Equal(t0) || !hi.Equal(t0.Add(windowFlights)) {
		t.Fatalf("expected [t, t+window) refill after subscribe, got lo=%v hi=%v due=%v", lo, hi, due)
	}
}

func TestSendFlightsHistoryEmitsChunkWithIDAndTime(t *testing.T) {
	s := newTestSession(t)
	ts := time.Date(2001, 9, 11, 12, 30, 0, 0, time.UTC)
	items := []model.FlightPosition{
		{ID: 1, Flight: "AA11", StartDate: ts, Lat: 42.36, Lon: -71.0, AltFt: 1000},
	}

	s.SendFlightsHistory(7, ts, items, false)

	m := recvType(t, s)
	if m.Type != "flights_history" {
		t.Fatalf("expected flights_history frame, got %q", m.Type)
	}
	if m.ID != 7 {
		t.Fatalf("expected echoed request id 7, got %d", m.ID)
	}
	if m.Done {
		t.Fatal("chunk frame must not carry done")
	}
	if len(m.Flights) != 1 || m.Flights[0].Flight != "AA11" {
		t.Fatalf("expected the AA11 position, got %+v", m.Flights)
	}
}

func TestSendFlightsHistoryEmptyChunkIsSuppressed(t *testing.T) {
	s := newTestSession(t)
	s.SendFlightsHistory(7, time.Now().UTC(), nil, false)
	select {
	case <-s.send:
		t.Fatal("empty non-done chunk must not emit a frame")
	default:
	}
}

func TestSendFlightsHistoryDoneFrameSentEvenWhenEmpty(t *testing.T) {
	s := newTestSession(t)
	s.SendFlightsHistory(7, time.Now().UTC(), nil, true)
	m := recvType(t, s)
	if m.Type != "flights_history" || !m.Done || m.ID != 7 {
		t.Fatalf("expected empty done frame with id 7, got %+v", m)
	}
	if len(m.Flights) != 0 {
		t.Fatalf("done marker should carry no flights, got %d", len(m.Flights))
	}
}

func TestSendWeatherEmitsFrame(t *testing.T) {
	s := newTestSession(t)
	at := time.Date(2001, 9, 11, 12, 51, 0, 0, time.UTC)
	tempC := 21.1

	s.SendWeather(at,
		[]model.WeatherObservation{{ID: 1, StationID: "KJFK", StartDate: at, TempC: &tempC}},
		[]model.WeatherForecast{{ID: 2, Wfo: "OKX", Zone: "NYZ072", StartDate: at, RawText: "Sunny."}},
	)

	m := recvType(t, s)
	if m.Type != "weather" {
		t.Fatalf("expected weather frame, got %q", m.Type)
	}
	if len(m.Weather) != 1 || m.Weather[0].StationID != "KJFK" || m.Weather[0].TempC == nil || *m.Weather[0].TempC != 21.1 {
		t.Fatalf("expected one weather observation, got %+v", m.Weather)
	}
	if len(m.WeatherForecasts) != 1 || m.WeatherForecasts[0].Zone != "NYZ072" || m.WeatherForecasts[0].RawText != "Sunny." {
		t.Fatalf("expected one weather forecast, got %+v", m.WeatherForecasts)
	}
	if len(m.Items) != 0 || len(m.Flights) != 0 {
		t.Fatalf("weather frame must not carry other payloads, got %+v", m)
	}
}

func TestSendWeatherSuppressesEmptyBatch(t *testing.T) {
	s := newTestSession(t)
	s.SendWeather(time.Date(2001, 9, 11, 3, 0, 0, 0, time.UTC), nil, nil)

	select {
	case data := <-s.send:
		t.Fatalf("expected no frame for empty weather batch, got %d bytes", len(data))
	default:
	}
}

func TestWeatherHorizonResetOnSubscribeInitAndSeek(t *testing.T) {
	s := newTestSession(t)
	t0 := time.Date(2001, 9, 11, 12, 40, 0, 0, time.UTC)

	s.Init(t0, nil)
	if !s.weatherHorizon.Equal(t0) {
		t.Fatalf("Init must reset weatherHorizon to t, got %v", s.weatherHorizon)
	}

	s.Subscribe(ChannelWeather)
	if !s.Subscribed(ChannelWeather) {
		t.Fatal("expected weather subscription after Subscribe")
	}

	t1 := t0.Add(2 * time.Hour)
	s.Seek(t1, nil)
	if !s.weatherHorizon.Equal(t1) {
		t.Fatalf("Seek must reset weatherHorizon to t, got %v", s.weatherHorizon)
	}
}

func TestWeatherRefillRequiresSubscription(t *testing.T) {
	s := newTestSession(t)
	t0 := time.Date(2001, 9, 11, 12, 40, 0, 0, time.UTC)
	s.mu.Lock()
	s.virtualTime = t0
	s.weatherHorizon = t0
	if _, _, due := s.planChannelRefill(ChannelWeather, &s.weatherHorizon, t0, windowWeather); due {
		s.mu.Unlock()
		t.Fatal("unsubscribed weather channel must never refill")
	}
	s.mu.Unlock()

	s.Subscribe(ChannelWeather)
	s.mu.Lock()
	lo, hi, due := s.planChannelRefill(ChannelWeather, &s.weatherHorizon, t0, windowWeather)
	s.mu.Unlock()
	if !due || !lo.Equal(t0) || !hi.Equal(t0.Add(windowWeather)) {
		t.Fatalf("expected [t, t+window) refill after subscribe, got lo=%v hi=%v due=%v", lo, hi, due)
	}
}

func TestSubscribeAlertsAck(t *testing.T) {
	s := newTestSession(t)

	if s.Subscribed(ChannelAlerts) {
		t.Fatal("new session should not be subscribed to alerts")
	}

	s.Subscribe(ChannelAlerts)
	if !s.Subscribed(ChannelAlerts) {
		t.Fatal("expected alerts subscription after Subscribe")
	}
	if ack := recvType(t, s); ack.Type != "subscribe_ack" || ack.Channel != ChannelAlerts {
		t.Fatalf("expected subscribe_ack for alerts, got %+v", ack)
	}
}

func TestSendAlertsFrameType(t *testing.T) {
	s := newTestSession(t)
	now := time.Date(2001, 9, 11, 12, 40, 0, 0, time.UTC)
	severity := "caution"

	s.SendAlerts(now, []model.AlertItem{{MediaItem: model.MediaItem{ID: 7, Title: "Test"}, Severity: &severity}})

	m := recvType(t, s)
	if m.Type != "alerts" {
		t.Fatalf("expected alerts frame, got %q", m.Type)
	}
	if len(m.Alerts) != 1 || m.Alerts[0].Title != "Test" || m.Alerts[0].Severity == nil || *m.Alerts[0].Severity != "caution" {
		t.Fatalf("expected one alert item with severity, got %+v", m.Alerts)
	}
	if len(m.Items) != 0 {
		t.Fatalf("alerts frame must not carry items payload, got %+v", m.Items)
	}
}

func TestSendAlertsSuppressesEmptyBatch(t *testing.T) {
	s := newTestSession(t)
	s.SendAlerts(time.Date(2001, 9, 11, 3, 0, 0, 0, time.UTC), nil)

	select {
	case data := <-s.send:
		t.Fatalf("expected no frame for empty alerts batch, got %d bytes", len(data))
	default:
	}
}

func TestSendWeatherForecastNilStillSends(t *testing.T) {
	s := newTestSession(t)
	at := time.Date(2001, 9, 11, 12, 51, 0, 0, time.UTC)

	s.SendWeatherForecast(42, at, nil)

	m := recvType(t, s)
	if m.Type != "weather_forecast" {
		t.Fatalf("expected weather_forecast frame, got %q", m.Type)
	}
	if m.ID != 42 {
		t.Fatalf("expected echoed request id 42, got %d", m.ID)
	}
	if len(m.WeatherForecasts) != 0 {
		t.Fatalf("nil forecast must send an empty list, got %+v", m.WeatherForecasts)
	}
}

// forcedTestSession returns a session whose hub has an ACTIVE master clock
// pinned at target, plus the MasterClock for further manipulation.
func forcedTestSession(t *testing.T, target time.Time) (*Session, *clock.MasterClock) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis.Run: %v", err)
	}
	t.Cleanup(mr.Close)
	rdb := goredis.NewClient(&goredis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	mc := clock.New(rdb, logger)
	if err := mc.Set(context.Background(), target); err != nil {
		t.Fatalf("mc.Set: %v", err)
	}
	hub := NewHub(logger, 0)
	hub.SetMaster(mc)
	return NewSession(hub, nil, nil, logger), mc
}

func TestHeartbeatUnforcedHasNoMasterTime(t *testing.T) {
	s := newTestSession(t)
	s.Heartbeat(time.Date(2001, 9, 11, 13, 0, 0, 0, time.UTC))
	ack := recvType(t, s)
	if ack.Type != "heartbeat_ack" || ack.MasterTime != "" {
		t.Fatalf("expected plain heartbeat_ack, got %+v", ack)
	}
}

func TestHeartbeatForcedPinsToMasterAndAcksMasterTime(t *testing.T) {
	master := time.Date(2001, 9, 11, 13, 3, 0, 0, time.UTC)
	s, _ := forcedTestSession(t, master)

	// Client reports a wildly different time; the server must ignore it.
	s.Heartbeat(time.Date(2001, 9, 11, 8, 0, 0, 0, time.UTC))
	ack := recvType(t, s)
	if ack.Type != "heartbeat_ack" {
		t.Fatalf("expected heartbeat_ack, got %+v", ack)
	}
	if ack.MasterTime == "" {
		t.Fatal("expected master_time while forced")
	}
	ackTime, err := time.Parse(time.RFC3339, ack.MasterTime)
	if err != nil {
		t.Fatalf("bad master_time: %v", err)
	}
	if d := ackTime.Sub(master); d < 0 || d > 2*time.Second {
		t.Fatalf("master_time %v not near master %v", ackTime, master)
	}
	vt, _ := s.VirtualTime()
	if vt.Sub(master) < 0 || vt.Sub(master) > 2*time.Second {
		t.Fatalf("virtualTime %v not pinned to master %v", vt, master)
	}
}

func TestSendClock(t *testing.T) {
	s := newTestSession(t)
	target := time.Date(2001, 9, 11, 13, 3, 0, 0, time.UTC)

	s.SendClock(true, target)
	m := recvType(t, s)
	if m.Type != "clock" || m.Active == nil || !*m.Active || m.Time != target.Format(time.RFC3339) {
		t.Fatalf("bad active clock frame: %+v", m)
	}

	s.SendClock(false, time.Time{})
	m = recvType(t, s)
	if m.Type != "clock" || m.Active == nil || *m.Active || m.Time != "" {
		t.Fatalf("bad release clock frame: %+v", m)
	}
}

func TestPauseIgnoredWhileForced(t *testing.T) {
	s, _ := forcedTestSession(t, time.Date(2001, 9, 11, 13, 0, 0, 0, time.UTC))
	s.Pause()
	if ack := recvType(t, s); ack.Type != "pause_ack" {
		t.Fatalf("expected pause_ack, got %+v", ack)
	}
	s.mu.Lock()
	paused := s.paused
	s.mu.Unlock()
	if paused {
		t.Fatal("pause must not apply while the clock is forced")
	}
}

func TestBroadcastClockReachesRegisteredSessions(t *testing.T) {
	master := time.Date(2001, 9, 11, 13, 3, 0, 0, time.UTC)
	s, mc := forcedTestSession(t, master)
	hub := s.hub
	// Register synchronously (bypass the async reg channel — Run isn't running).
	hub.mu.Lock()
	hub.sessions[s.id] = s
	hub.mu.Unlock()

	hub.BroadcastClock(mc.Snapshot())
	m := recvType(t, s)
	if m.Type != "clock" || m.Active == nil || !*m.Active {
		t.Fatalf("expected active clock broadcast, got %+v", m)
	}

	hub.BroadcastClock(clock.State{Active: false})
	m = recvType(t, s)
	if m.Type != "clock" || m.Active == nil || *m.Active {
		t.Fatalf("expected release clock broadcast, got %+v", m)
	}
}

func TestSendNewsBodyEmitsBodyFrame(t *testing.T) {
	s := newTestSession(t)

	s.SendNewsBody(4210, "<p>Two planes have struck…</p>", "")

	m := recvType(t, s)
	if m.Type != "news_body" {
		t.Fatalf("expected news_body frame, got %q", m.Type)
	}
	if m.ID != 4210 {
		t.Fatalf("expected id 4210, got %d", m.ID)
	}
	if m.Body != "<p>Two planes have struck…</p>" {
		t.Fatalf("unexpected body %q", m.Body)
	}
	if m.Msg != "" {
		t.Fatalf("success frame must carry no message, got %q", m.Msg)
	}
}

// A failure must still reply, with an empty body and a message — that is what lets
// the client show an error line instead of hanging on "loading" forever, and what
// distinguishes "unavailable" from an article that is genuinely empty.
func TestSendNewsBodyEmitsErrorFrame(t *testing.T) {
	s := newTestSession(t)

	s.SendNewsBody(4211, "", "article unavailable")

	m := recvType(t, s)
	if m.Type != "news_body" {
		t.Fatalf("expected news_body frame, got %q", m.Type)
	}
	if m.ID != 4211 {
		t.Fatalf("expected id 4211, got %d", m.ID)
	}
	if m.Body != "" {
		t.Fatalf("error frame must carry an empty body, got %q", m.Body)
	}
	if m.Msg != "article unavailable" {
		t.Fatalf("expected explanatory message, got %q", m.Msg)
	}
}
func TestChatStateRequiresSignIn(t *testing.T) {
	s := newTestSession(t)
	s.Init(time.Date(2001, 9, 11, 14, 0, 0, 0, time.UTC), nil)
	drain(t, s)

	s.SendChatState()
	msg := recvType(t, s)
	if msg.Type != "chat_state" {
		t.Fatalf("Type = %q, want chat_state", msg.Type)
	}
	if msg.Enabled == nil || *msg.Enabled {
		t.Fatal("chat should be disabled for an anonymous session")
	}
	if msg.Reason != "not_signed_in" {
		t.Fatalf("Reason = %q, want not_signed_in", msg.Reason)
	}
}

func TestChatStateEnabledWhenSignedInMidWindow(t *testing.T) {
	s := newTestSession(t)
	s.SetUser("11111111-2222-3333-4444-555555555555")
	s.Init(time.Date(2001, 9, 11, 14, 0, 0, 0, time.UTC), nil)
	drain(t, s)

	s.SendChatState()
	msg := recvType(t, s)
	if msg.Enabled == nil || !*msg.Enabled {
		t.Fatalf("chat should be enabled; reason=%q", msg.Reason)
	}
	if msg.Reason != "ok" {
		t.Fatalf("Reason = %q, want ok", msg.Reason)
	}
}

func TestChatStateDisabledWhilePaused(t *testing.T) {
	s := newTestSession(t)
	s.SetUser("11111111-2222-3333-4444-555555555555")
	s.Init(time.Date(2001, 9, 11, 14, 0, 0, 0, time.UTC), nil)
	s.Pause()
	drain(t, s)

	s.SendChatState()
	msg := recvType(t, s)
	if msg.Enabled == nil || *msg.Enabled {
		t.Fatal("chat should be disabled while paused")
	}
	if msg.Reason != "paused" {
		t.Fatalf("Reason = %q, want paused", msg.Reason)
	}
}

func TestChatRosterMarksOnlineByClock(t *testing.T) {
	s := newTestSession(t)
	s.SetUser("11111111-2222-3333-4444-555555555555")
	from := time.Date(2001, 9, 11, 15, 0, 0, 0, time.UTC)
	s.SetProfiles([]chat.Profile{
		{ID: 1, ScreenName: "mom", Sort: 0},
		{ID: 2, ScreenName: "skaterboi1988", Sort: 1, OnlineFrom: &from},
	})
	s.Init(time.Date(2001, 9, 11, 14, 0, 0, 0, time.UTC), nil)
	drain(t, s)

	s.SendChatRoster()
	msg := recvType(t, s)
	if msg.Type != "chat_roster" {
		t.Fatalf("Type = %q, want chat_roster", msg.Type)
	}
	if len(msg.Buddies) != 2 {
		t.Fatalf("Buddies length = %d, want 2", len(msg.Buddies))
	}
	if !msg.Buddies[0].Online {
		t.Fatal("mom should be online at 14:00")
	}
	if msg.Buddies[1].Online {
		t.Fatal("skaterboi1988 should be offline at 14:00 (online_from 15:00)")
	}
}

func TestPauseSendsNoChatStateWhenUnsubscribed(t *testing.T) {
	s := newTestSession(t)
	s.SetUser("11111111-2222-3333-4444-555555555555")
	s.Init(time.Date(2001, 9, 11, 14, 0, 0, 0, time.UTC), nil)
	drain(t, s)

	s.Pause()

	msg := recvType(t, s)
	if msg.Type != "pause_ack" {
		t.Fatalf("Type = %q, want pause_ack", msg.Type)
	}
	select {
	case extra := <-s.send:
		t.Fatalf("unsubscribed session got an extra frame after pause: %q", string(extra))
	default:
	}
}

func TestPauseSendsChatStateWhenSubscribed(t *testing.T) {
	s := newTestSession(t)
	s.SetUser("11111111-2222-3333-4444-555555555555")
	s.Subscribe(ChannelChat)
	s.Init(time.Date(2001, 9, 11, 14, 0, 0, 0, time.UTC), nil)
	drain(t, s)

	s.Pause()

	if msg := recvType(t, s); msg.Type != "pause_ack" {
		t.Fatalf("Type = %q, want pause_ack", msg.Type)
	}
	msg := recvType(t, s)
	if msg.Type != "chat_state" {
		t.Fatalf("Type = %q, want chat_state", msg.Type)
	}
	if msg.Enabled == nil || *msg.Enabled {
		t.Fatal("chat should be disabled while paused")
	}
	if msg.Reason != "paused" {
		t.Fatalf("Reason = %q, want paused", msg.Reason)
	}
}

func TestSeekEmitsPresenceOnlyOnChange(t *testing.T) {
	s := newTestSession(t)
	s.SetUser("11111111-2222-3333-4444-555555555555")
	s.Subscribe(ChannelChat)
	from := time.Date(2001, 9, 11, 15, 0, 0, 0, time.UTC)
	s.SetProfiles([]chat.Profile{
		{ID: 1, ScreenName: "mom", Sort: 0},
		{ID: 2, ScreenName: "skaterboi1988", Sort: 1, OnlineFrom: &from},
	})
	s.Init(time.Date(2001, 9, 11, 14, 0, 0, 0, time.UTC), nil)
	drain(t, s)

	s.Seek(time.Date(2001, 9, 11, 15, 30, 0, 0, time.UTC), nil)

	var presence []outMsg
	for {
		select {
		case data := <-s.send:
			var m outMsg
			dec := msgpack.NewDecoder(bytes.NewReader(data))
			dec.SetCustomStructTag("json")
			if err := dec.Decode(&m); err != nil {
				t.Fatalf("decode outbound: %v", err)
			}
			if m.Type == "chat_presence" {
				presence = append(presence, m)
			}
			continue
		default:
		}
		break
	}

	if len(presence) != 1 {
		t.Fatalf("got %d chat_presence frames, want 1", len(presence))
	}
	if presence[0].Profile != 2 {
		t.Fatalf("Profile = %d, want 2", presence[0].Profile)
	}
	if presence[0].Online == nil || !*presence[0].Online {
		t.Fatal("skaterboi1988 should be online at 15:30")
	}

	s.Seek(time.Date(2001, 9, 11, 15, 45, 0, 0, time.UTC), nil)
	drainAck := recvType(t, s)
	if drainAck.Type != "seek_ack" {
		t.Fatalf("Type = %q, want seek_ack", drainAck.Type)
	}
	for {
		select {
		case data := <-s.send:
			var m outMsg
			dec := msgpack.NewDecoder(bytes.NewReader(data))
			dec.SetCustomStructTag("json")
			if err := dec.Decode(&m); err != nil {
				t.Fatalf("decode outbound: %v", err)
			}
			if m.Type == "chat_presence" {
				t.Fatalf("second seek within the same window emitted chat_presence for profile %d", m.Profile)
			}
			continue
		default:
		}
		break
	}
}

// TestChatSendIsRejectedWhilePaused adapts the task-9 brief's version of this
// test: the brief never calls Init, so virtualTime stays zero and
// chat.Available's window check (which runs before the paused check) would
// answer "outside_window" instead of "paused" -- exactly what
// TestChatStateDisabledWhilePaused above already establishes needs an Init
// first. Added here so the gate is actually exercised on the paused branch.
func TestChatSendIsRejectedWhilePaused(t *testing.T) {
	// The UI disabling its input is UX; the server refusing is the guarantee.
	s := newTestSession(t)
	s.SetUser("user-1")
	s.Subscribe(ChannelChat)
	s.Init(time.Date(2001, 9, 11, 14, 0, 0, 0, time.UTC), nil)
	s.Pause()
	drain(t, s) // subscribe_ack, init_ack, and the chat_state frames Init/Pause already emit

	s.ChatSend(1, "hello")

	msg := recvType(t, s)
	if msg.Type != "chat_state" || msg.Reason != "paused" {
		t.Errorf("expected chat_state paused, got %+v", msg)
	}
}

func TestChatSendIsRejectedWhenNotSignedIn(t *testing.T) {
	s := newTestSession(t)
	s.Subscribe(ChannelChat)
	drain(t, s)

	s.ChatSend(1, "hello")

	msg := recvType(t, s)
	if msg.Reason != "not_signed_in" {
		t.Errorf("expected not_signed_in, got %q", msg.Reason)
	}
}

// TestChatSendEmitsTypingBeforeTheReply adapts the brief's s.SetTime, which
// does not exist on Session, to the real clock-setting entry point: Init.
func TestChatSendEmitsTypingBeforeTheReply(t *testing.T) {
	// The typing indicator is the latency budget, not decoration.
	s := newTestSession(t)
	s.SetUser("user-1")
	s.Subscribe(ChannelChat)
	s.Init(time.Date(2001, 9, 11, 12, 50, 0, 0, time.UTC), nil)
	drain(t, s)

	s.ChatSend(1, "hey")

	if msg := recvType(t, s); msg.Type != "chat_typing" {
		t.Errorf("first frame must be chat_typing, got %q", msg.Type)
	}
}

// TestChatSendWithNilGeneratorStillStalls proves a session with no generator
// configured (the newTestSession default -- and the production state whenever
// no provider has a configured API key) degrades ChatSend to the same
// in-character chat_message stall a full queue produces, rather than a panic
// or an error frame.
func TestChatSendWithNilGeneratorStillStalls(t *testing.T) {
	s := newTestSession(t)
	s.SetUser("user-1")
	s.Subscribe(ChannelChat)
	s.Init(time.Date(2001, 9, 11, 12, 50, 0, 0, time.UTC), nil)
	drain(t, s)

	s.ChatSend(1, "hey")

	if msg := recvType(t, s); msg.Type != "chat_typing" {
		t.Fatalf("first frame must be chat_typing, got %q", msg.Type)
	}
	msg := recvType(t, s)
	if msg.Type != "chat_message" || msg.Kind != "stall" || msg.Body == "" {
		t.Fatalf("expected an in-character stall chat_message, got %+v", msg)
	}
}

// TestBuildChatJobRoutesTiersWithoutCrossing guards the caller contract Task
// 1's review carried forward: tier-3 (retrospective, investigative) passages
// must reach Job.Timeline and must never reach Job.Digest, which the composer
// treats as things the buddy plainly knows. A Digest/Timeline swap here would
// present retrospective reporting as first-hand knowledge and would be
// invisible to any test that only checks a reply came back.
func TestBuildChatJobRoutesTiersWithoutCrossing(t *testing.T) {
	digest := []chat.Passage{{Tier: chat.TierCurated, Text: "digest-marker"}}
	recent := []chat.Passage{{Tier: chat.TierBroadcast, Text: "recent-marker"}}
	timeline := []chat.Passage{{Tier: chat.TierTimeline, Text: "timeline-marker"}}

	job := buildChatJob("user-1", chat.Profile{ID: 3}, nil, nil, "hi", "generated", false,
		time.Date(2001, 9, 11, 12, 50, 0, 0, time.UTC),
		digest, recent, timeline, nil, func(chat.Reply, error) {})

	if len(job.Digest) != 1 || job.Digest[0].Text != "digest-marker" {
		t.Fatalf("Job.Digest = %+v, want exactly the curated passage", job.Digest)
	}
	if len(job.Recent) != 1 || job.Recent[0].Text != "recent-marker" {
		t.Fatalf("Job.Recent = %+v, want exactly the broadcast passage", job.Recent)
	}
	if len(job.Timeline) != 1 || job.Timeline[0].Text != "timeline-marker" {
		t.Fatalf("Job.Timeline = %+v, want exactly the timeline passage", job.Timeline)
	}
	for _, p := range job.Digest {
		if p.Tier == chat.TierTimeline {
			t.Fatal("a tier-3 passage reached Job.Digest -- retrospective reporting would present as first-hand knowledge")
		}
	}
	for _, p := range job.Timeline {
		if p.Tier != chat.TierTimeline {
			t.Fatal("Job.Timeline must carry only tier-3 passages")
		}
	}
}

// TestBuildChatJobResolvesPhaseFromVirtualTime is the fix-round-1 regression
// test for the phase-resolution finding: buildChatJob previously hardcoded
// chat.DefaultPhase into every Job, which would make every buddy emotionally
// flat all day regardless of the virtual clock -- the product's central idea,
// inert. A test that only checked *a* phase was present would not have caught
// that regression; this one requires the phase to actually change between two
// virtual times straddling a beacon's public_at.
func TestBuildChatJobResolvesPhaseFromVirtualTime(t *testing.T) {
	beaconID := 1
	beacons := map[int]chat.Beacon{
		1: {
			ID: 1, Key: "first_impact",
			At:       time.Date(2001, 9, 11, 12, 46, 0, 0, time.UTC),
			PublicAt: time.Date(2001, 9, 11, 12, 51, 0, 0, time.UTC),
		},
	}
	phases := map[int][]chat.Phase{
		3: {
			{ID: 10, ProfileID: 3, FromBeacon: nil, Tone: "ordinary morning", Sort: 0, Shock: 0},
			{ID: 11, ProfileID: 3, FromBeacon: &beaconID, Tone: "shaken", Sort: 1, Shock: 80},
		},
	}
	noop := func(chat.Reply, error) {}

	before := buildChatJob("user-1", chat.Profile{ID: 3}, phases, beacons, "hi", "generated", false,
		time.Date(2001, 9, 11, 12, 48, 0, 0, time.UTC), nil, nil, nil, nil, noop)
	after := buildChatJob("user-1", chat.Profile{ID: 3}, phases, beacons, "hi", "generated", false,
		time.Date(2001, 9, 11, 14, 0, 0, 0, time.UTC), nil, nil, nil, nil, noop)

	if before.Phase.ID != 10 {
		t.Fatalf("before the beacon's public_at, Job.Phase = %+v, want the opening phase (id 10)", before.Phase)
	}
	if after.Phase.ID != 11 {
		t.Fatalf("after the beacon's public_at, Job.Phase = %+v, want the shaken phase (id 11)", after.Phase)
	}
	if before.Phase == after.Phase {
		t.Fatal("Job.Phase must change with virtual time -- a hardcoded DefaultPhase would make this pass trivially")
	}
}

// TestBuildChatJobFallsBackToDefaultPhaseWithNoConfig covers the no-content
// path buildChatJob leaves to chat.PhaseAt: a profile with no phases
// configured (nil maps, exactly like a fresh install or a unit test with no
// SetPhaseData call) must still resolve to a Phase, not a zero value.
func TestBuildChatJobFallsBackToDefaultPhaseWithNoConfig(t *testing.T) {
	job := buildChatJob("user-1", chat.Profile{ID: 3}, nil, nil, "hi", "generated", false,
		time.Date(2001, 9, 11, 12, 50, 0, 0, time.UTC), nil, nil, nil, nil, func(chat.Reply, error) {})

	if job.Phase != chat.DefaultPhase {
		t.Fatalf("Job.Phase = %+v, want chat.DefaultPhase", job.Phase)
	}
}

// TestGeneratedBeatJobCarriesKnowledgeTiers is the fix-round-1 regression test
// for the grounding finding: fireBeats' generated-kind branch used to build
// its chat.Job by hand, omitting Digest/Recent/Timeline/History entirely, so a
// scheduled beat would generate with no curated facts, no broadcast
// transcript, and no timeline behind it — inventing its own reaction to a
// real event. fireBeats now retrieves the same tiers a typed ChatSend does
// (retrieveContext) and builds its job through the same buildChatJob call
// shape (kind "scheduled", selfInitiated true, sc.Prompt as Body); this
// proves that shape actually carries non-empty tiers through rather than
// dropping them, exactly as TestBuildChatJobRoutesTiersWithoutCrossing proves
// for a typed reply.
func TestGeneratedBeatJobCarriesKnowledgeTiers(t *testing.T) {
	digest := []chat.Passage{{Tier: chat.TierCurated, Text: "a plane hit the north tower"}}
	recent := []chat.Passage{{Tier: chat.TierBroadcast, Text: "breaking coverage begins"}}
	timeline := []chat.Passage{{Tier: chat.TierTimeline, Text: "investigators later found"}}
	history := []chat.Turn{{FromBuddy: false, Text: "hey"}, {FromBuddy: true, Text: "hey!"}}

	job := buildChatJob("user-1", chat.Profile{ID: 5}, nil, nil, "react to the second impact",
		"scheduled", true, time.Date(2001, 9, 11, 13, 3, 0, 0, time.UTC),
		digest, recent, timeline, history, func(chat.Reply, error) {})

	if len(job.Digest) == 0 || len(job.Recent) == 0 || len(job.Timeline) == 0 || len(job.History) == 0 {
		t.Fatalf("a generated beat's job must carry every retrieved tier, got Digest=%d Recent=%d Timeline=%d History=%d",
			len(job.Digest), len(job.Recent), len(job.Timeline), len(job.History))
	}
	if !job.SelfInitiated {
		t.Error("a generated beat's job must be marked SelfInitiated so the composer never renders it as a reply")
	}
	if job.Kind != "scheduled" {
		t.Errorf("Kind = %q, want scheduled", job.Kind)
	}
	if job.Body != "react to the second impact" {
		t.Errorf("Body = %q, want the schedule's Prompt", job.Body)
	}
}

// dueBeatsLocked is a small test helper mirroring the lock/unlock RunTimePump
// wraps dueBeats in, so these tests exercise the exact function the tick path
// calls rather than reimplementing its logic.
func dueBeatsLocked(s *Session, t time.Time) []chat.Schedule {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.dueBeats(t)
}

func TestDueBeatsRequiresChatSubscription(t *testing.T) {
	s := newTestSession(t)
	s.Init(time.Date(2001, 9, 11, 12, 50, 0, 0, time.UTC), nil)
	fireAt := time.Date(2001, 9, 11, 12, 51, 0, 0, time.UTC)
	s.SetSchedules([]chat.Schedule{{ID: 1, ProfileID: 5, Kind: "static", Text: "hey", At: &fireAt}})

	if got := dueBeatsLocked(s, fireAt); len(got) != 0 {
		t.Fatalf("a session never subscribed to chat must get no beats, got %d", len(got))
	}

	s.Subscribe(ChannelChat)
	if got := dueBeatsLocked(s, fireAt); len(got) != 1 {
		t.Fatalf("once subscribed, the due beat must be reported, got %d", len(got))
	}
}

func TestDueBeatsFiresExactlyOnceAsHorizonAdvances(t *testing.T) {
	s := newTestSession(t)
	s.Init(time.Date(2001, 9, 11, 12, 50, 0, 0, time.UTC), nil)
	s.Subscribe(ChannelChat)
	fireAt := time.Date(2001, 9, 11, 12, 51, 0, 0, time.UTC)
	s.SetSchedules([]chat.Schedule{{ID: 1, ProfileID: 5, Kind: "static", Text: "hey", At: &fireAt}})

	if got := dueBeatsLocked(s, fireAt); len(got) != 1 {
		t.Fatalf("first tick landing on the fire time must report the beat, got %d", len(got))
	}
	if got := dueBeatsLocked(s, fireAt.Add(time.Second)); len(got) != 0 {
		t.Fatalf("the next tick must not report the same beat again, got %d", len(got))
	}
}

func TestDueBeatsIsInertWithNoSchedules(t *testing.T) {
	// chat_schedules has zero rows in production; this must produce nothing,
	// not an error or a warning, on every ordinary tick.
	s := newTestSession(t)
	s.Init(time.Date(2001, 9, 11, 12, 50, 0, 0, time.UTC), nil)
	s.Subscribe(ChannelChat)

	if got := dueBeatsLocked(s, time.Date(2001, 9, 11, 14, 0, 0, 0, time.UTC)); got != nil {
		t.Fatalf("no schedules configured must yield nil, got %v", got)
	}
}

func TestFireBeatsStaticDeliversTextWithoutProviderCall(t *testing.T) {
	s := newTestSession(t)
	s.SetUser("11111111-2222-3333-4444-555555555555")
	vTime := time.Date(2001, 9, 11, 12, 51, 0, 0, time.UTC)
	s.Init(vTime, nil)
	drain(t, s)

	due := []chat.Schedule{{ID: 1, ProfileID: 5, Kind: "static", Text: "hang on, are you seeing this?"}}
	s.fireBeats(context.Background(), due, "11111111-2222-3333-4444-555555555555", nil, nil, nil, vTime)

	msg := recvType(t, s)
	if msg.Type != "chat_message" || msg.Kind != "static" || msg.Body != "hang on, are you seeing this?" {
		t.Fatalf("expected a static chat_message, got %+v", msg)
	}
}

func TestFireBeatsGeneratedKindStallsWithNoGenerator(t *testing.T) {
	// Mirrors TestChatSendWithNilGeneratorStillStalls: a session with no
	// generator configured (newTestSession's default) must degrade a
	// generated beat to the same in-character stall, not a panic or silence.
	s := newTestSession(t)
	s.SetUser("11111111-2222-3333-4444-555555555555")
	vTime := time.Date(2001, 9, 11, 12, 51, 0, 0, time.UTC)
	s.Init(vTime, nil)
	drain(t, s)

	due := []chat.Schedule{{ID: 1, ProfileID: 5, Kind: "generated", Prompt: "react to the news"}}
	s.fireBeats(context.Background(), due, "11111111-2222-3333-4444-555555555555", nil, nil, nil, vTime)

	if msg := recvType(t, s); msg.Type != "chat_typing" {
		t.Fatalf("first frame must be chat_typing, got %q", msg.Type)
	}
	msg := recvType(t, s)
	if msg.Type != "chat_message" || msg.Kind != "stall" || msg.Body == "" {
		t.Fatalf("expected an in-character stall chat_message, got %+v", msg)
	}
}

func TestFireBeatsSkipsWhenGateFails(t *testing.T) {
	// A session that is not signed in must get no beat, exactly as ChatSend
	// refuses a send under the same gate.
	s := newTestSession(t)
	s.Init(time.Date(2001, 9, 11, 12, 51, 0, 0, time.UTC), nil)
	drain(t, s)

	due := []chat.Schedule{{ID: 1, ProfileID: 5, Kind: "static", Text: "hey"}}
	s.fireBeats(context.Background(), due, "", nil, nil, nil, time.Date(2001, 9, 11, 12, 51, 0, 0, time.UTC))

	select {
	case data := <-s.send:
		t.Fatalf("expected no frame while the chat gate fails, got a frame: %v", data)
	default:
	}
}

func TestFireBeatsSkipsRequiresPriorContactWithNilPool(t *testing.T) {
	// requires_prior_contact must gate the beat on HasPriorContact; with no
	// pool to check against, the safe default is to skip, not to fire.
	s := newTestSession(t)
	s.SetUser("11111111-2222-3333-4444-555555555555")
	vTime := time.Date(2001, 9, 11, 12, 51, 0, 0, time.UTC)
	s.Init(vTime, nil)
	drain(t, s)

	due := []chat.Schedule{{ID: 1, ProfileID: 5, Kind: "static", Text: "hey", RequiresPriorContact: true}}
	s.fireBeats(context.Background(), due, "11111111-2222-3333-4444-555555555555", nil, nil, nil, vTime)

	select {
	case data := <-s.send:
		t.Fatalf("expected no frame when prior contact cannot be checked, got a frame: %v", data)
	default:
	}
}
