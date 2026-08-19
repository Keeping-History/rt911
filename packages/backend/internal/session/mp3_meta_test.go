package session

import (
	"bytes"
	"reflect"
	"sort"
	"testing"
	"time"

	"classicy/streamer/internal/model"

	"github.com/vmihailenco/msgpack/v5"
)

// rawFrame decodes one outbound frame to its top-level wire fields and nothing
// more, so a test can assert on which keys are present rather than on which
// keys a Go struct happens to have somewhere to put.
func rawFrame(t *testing.T, data []byte) map[string]msgpack.RawMessage {
	t.Helper()
	var m map[string]msgpack.RawMessage
	dec := msgpack.NewDecoder(bytes.NewReader(data))
	dec.SetCustomStructTag("json")
	if err := dec.Decode(&m); err != nil {
		t.Fatalf("decode outbound frame: %v", err)
	}
	return m
}

func frameKeys(m map[string]msgpack.RawMessage) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// nextFrameType returns the type of the next queued frame without requiring it
// to fit outMsg — mp3_meta does not (its items are an id-keyed map).
func nextFrameType(t *testing.T, s *Session) (string, []byte) {
	t.Helper()
	select {
	case data := <-s.send:
		f := rawFrame(t, data)
		var typ string
		if raw, ok := f["type"]; ok {
			if err := msgpack.Unmarshal(raw, &typ); err != nil {
				t.Fatalf("decode frame type: %v", err)
			}
		}
		return typ, data
	default:
		t.Fatal("expected an outbound message, got none")
		return "", nil
	}
}

func sampleItemMeta() map[int]model.ItemMeta {
	return map[int]model.ItemMeta{
		5821: {
			Subject:      "Boston Center coordinates with NEADS",
			Tier:         "primary",
			Participants: []model.Participant{{Person: "Powell", Facility: "ZBW", Role: "controller"}},
			Tags:         []model.Tag{{Tag: "facility:zbw", Namespace: "facility", Value: "ZBW"}},
			Peaks:        [][2]int8{{-3, 3}, {-12, 10}},
		},
		5822: {Subject: "NEADS scramble order", Tags: []model.Tag{}},
	}
}

func TestSubscribingToMp3EmitsExactlyOneMetaFrame(t *testing.T) {
	s := newTestSession(t)
	s.Subscribe(ChannelMp3)
	drain(t, s) // subscribe_ack

	s.SendMp3Meta("gen-1", sampleItemMeta())

	typ, data := nextFrameType(t, s)
	if typ != "mp3_meta" {
		t.Fatalf("expected an mp3_meta frame, got %q", typ)
	}

	var frame Mp3MetaMessage
	dec := msgpack.NewDecoder(bytes.NewReader(data))
	dec.SetCustomStructTag("json")
	if err := dec.Decode(&frame); err != nil {
		t.Fatalf("decode mp3_meta: %v", err)
	}
	if len(frame.Items) != 2 {
		t.Fatalf("expected metadata for 2 items, got %d", len(frame.Items))
	}
	if frame.Items[5821].Participants[0].Person != "Powell" {
		t.Fatalf("participants did not survive the wire: %+v", frame.Items[5821])
	}
	if got := frame.Items[5821].Peaks; len(got) != 2 || got[1] != [2]int8{-12, 10} {
		t.Fatalf("peaks did not survive the wire: %+v", got)
	}

	// A second attempt — a resubscribe, a reconnecting app, anything — must not
	// put another ~1.5 MB on the socket.
	s.SendMp3Meta("gen-1", sampleItemMeta())
	select {
	case data := <-s.send:
		typ, _ := "", data
		f := rawFrame(t, data)
		_ = msgpack.Unmarshal(f["type"], &typ)
		t.Fatalf("mp3_meta was sent twice; second frame was %q", typ)
	default:
	}
}

// The one-shot's whole purpose: mp3_history is the entire back catalogue and is
// re-sent on every seek. The metadata has no time dimension, so a seek cannot
// change it and re-sending it could only cost bandwidth.
func TestSeekResendsMp3AndHistoryButNotMeta(t *testing.T) {
	s := newTestSession(t)
	s.Subscribe(ChannelMp3)
	drain(t, s)

	at := time.Date(2001, 9, 11, 15, 26, 0, 0, time.UTC)
	items := []model.MediaItem{{ID: 5821, Title: "ID Rountree", Format: "mp3", URL: "x.mp3"}}

	// Subscribe-time delivery: metadata, then the item frames.
	s.SendMp3Meta("gen-1", sampleItemMeta())
	s.SendMp3(at, items)
	s.SendMp3History(at, items)

	if typ, _ := nextFrameType(t, s); typ != "mp3_meta" {
		t.Fatalf("expected mp3_meta first, got %q", typ)
	}
	if typ, _ := nextFrameType(t, s); typ != "mp3" {
		t.Fatalf("expected mp3 second, got %q", typ)
	}
	if typ, _ := nextFrameType(t, s); typ != "mp3_history" {
		t.Fatalf("expected mp3_history third, got %q", typ)
	}

	// Now a seek: the same delivery path runs again.
	seeked := at.Add(-2 * time.Hour)
	s.SendMp3Meta("gen-1", sampleItemMeta())
	s.SendMp3(seeked, items)
	s.SendMp3History(seeked, items)

	var got []string
	for {
		select {
		case data := <-s.send:
			var typ string
			f := rawFrame(t, data)
			if err := msgpack.Unmarshal(f["type"], &typ); err != nil {
				t.Fatalf("decode frame type: %v", err)
			}
			got = append(got, typ)
			continue
		default:
		}
		break
	}

	want := []string{"mp3", "mp3_history"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("after a seek the session sent %v, want %v", got, want)
	}
}

// Decision 2: the tag vocabulary is identical for every session, so it is served
// once over HTTP and browser-cached, not pushed down every socket.
func TestMp3MetaFrameCarriesNoVocabulary(t *testing.T) {
	s := newTestSession(t)
	s.SendMp3Meta("gen-1", sampleItemMeta())

	_, data := nextFrameType(t, s)
	got := frameKeys(rawFrame(t, data))
	want := []string{"generation", "items", "type"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("mp3_meta wire keys are %v, want %v", got, want)
	}

	// Structural, not just absent-on-this-payload: the envelope must have nowhere
	// to put a vocabulary at all.
	rt := reflect.TypeOf(Mp3MetaMessage{})
	for i := range rt.NumField() {
		f := rt.Field(i)
		if f.Type == reflect.TypeOf([]model.Tag(nil)) {
			t.Fatalf("Mp3MetaMessage.%s can carry the tag vocabulary; it must not", f.Name)
		}
	}
}

// A client holding a vocabulary from one build and item tags from another can
// render a chip its own filter tree has no checkbox for. The stamp is how it
// notices; GET /mp3/tags returns the same value for the same build.
func TestMp3MetaFrameStampsTheGeneration(t *testing.T) {
	s := newTestSession(t)
	s.SendMp3Meta("build-7f3a", sampleItemMeta())

	_, data := nextFrameType(t, s)
	var frame Mp3MetaMessage
	dec := msgpack.NewDecoder(bytes.NewReader(data))
	dec.SetCustomStructTag("json")
	if err := dec.Decode(&frame); err != nil {
		t.Fatalf("decode mp3_meta: %v", err)
	}
	if frame.Generation != "build-7f3a" {
		t.Fatalf("generation is %q, want %q", frame.Generation, "build-7f3a")
	}
}

// The cost this whole design avoids. mp3_history is ~755 items re-sent on every
// seek; at ~2 KB of metadata each, one metadata field on MediaItem would be
// ~1.5 MB per Time Machine scrub. These two frames must stay exactly what they
// were before mp3_meta existed.
func TestMp3FramesCarryNoMetadata(t *testing.T) {
	metadataKeys := []string{
		"subject", "link", "tier", "confidence", "evidence",
		"participants", "mentions", "provenance", "tags", "peaks", "generation",
	}

	for _, tc := range []struct {
		name string
		send func(s *Session, at time.Time, items []model.MediaItem)
		want []string
	}{
		{"mp3", func(s *Session, at time.Time, items []model.MediaItem) { s.SendMp3(at, items) },
			[]string{"items", "time", "type"}},
		{"mp3_history", func(s *Session, at time.Time, items []model.MediaItem) { s.SendMp3History(at, items) },
			[]string{"items", "time", "type"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newTestSession(t)
			at := time.Date(2001, 9, 11, 15, 26, 0, 0, time.UTC)
			tc.send(s, at, []model.MediaItem{{ID: 5821, Title: "ID Rountree", Format: "mp3", URL: "x.mp3"}})

			_, data := nextFrameType(t, s)
			frame := rawFrame(t, data)
			if got := frameKeys(frame); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("%s wire keys are %v, want %v", tc.name, got, tc.want)
			}

			var wireItems []map[string]msgpack.RawMessage
			if err := msgpack.Unmarshal(frame["items"], &wireItems); err != nil {
				t.Fatalf("decode items: %v", err)
			}
			if len(wireItems) != 1 {
				t.Fatalf("expected one item, got %d", len(wireItems))
			}
			for _, key := range metadataKeys {
				if _, ok := wireItems[0][key]; ok {
					t.Errorf("%s item carries metadata key %q; it belongs on mp3_meta", tc.name, key)
				}
			}
		})
	}
}
