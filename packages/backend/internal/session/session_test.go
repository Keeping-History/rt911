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
