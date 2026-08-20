package model

import (
	"bytes"
	"reflect"
	"testing"

	"github.com/vmihailenco/msgpack/v5"
)

// encodeLikeTheWire mirrors session.encodeMsg exactly: msgpack with
// SetCustomStructTag("json"), so the json: tags are the wire field names. If
// these diverge, every assertion below is testing a format nothing sends.
func encodeLikeTheWire(t *testing.T, v any) []byte {
	t.Helper()
	var buf bytes.Buffer
	enc := msgpack.NewEncoder(&buf)
	enc.SetCustomStructTag("json")
	if err := enc.Encode(v); err != nil {
		t.Fatalf("encode: %v", err)
	}
	return buf.Bytes()
}

func decodeLikeTheWire(t *testing.T, data []byte, dst any) {
	t.Helper()
	dec := msgpack.NewDecoder(bytes.NewReader(data))
	dec.SetCustomStructTag("json")
	if err := dec.Decode(dst); err != nil {
		t.Fatalf("decode: %v", err)
	}
}

// A fully-populated value: every field of every nested type carries a distinct
// non-zero value, so an omitempty that swallowed a field, or a field pair that
// got transposed, shows up as an inequality rather than passing by coincidence.
func fullItemMeta() ItemMeta {
	return ItemMeta{
		Subject:    "Boston Center tells New York Center that American 11 is not responding",
		Link:       "landline",
		Tier:       "clip",
		Confidence: "high",
		Evidence:   "American 11 is not responding",
		Participants: []Participant{
			{Person: "Joe Cooper", Facility: "Boston Center", Position: "AA sector", Role: "atc", Confidence: "high"},
			{Person: "Dave Bottiglia", Facility: "New York Center", Position: "R42", Role: "atc", Confidence: "medium"},
		},
		Mentions: &Mentions{
			Facilities: []string{"NEADS"},
			Aircraft:   []string{"UAL175"},
			People:     []string{"Ben Sliney"},
		},
		Provenance: &Provenance{
			GeneratedAt: "2026-08-13T10:00:00+00:00",
			Sources: map[string]string{
				"subject":         "transcript",
				"evidence":        "transcript",
				"mentions.people": "commission_monograph",
			},
			Commission: &Commission{
				Title:  "Boston Center / New York Center landline",
				Source: "Team 8 audio monograph",
				Stamp:  "09:16:00",
			},
		},
		Tags: []Tag{
			{Tag: "facility:zbw", Namespace: "facility", Value: "zbw", Color: "#c33"},
			{Tag: "topic:hijack-report", Namespace: "topic", Value: "hijack-report", Color: "#39c"},
		},
		Peaks: [][2]int8{{-128, 127}, {0, 0}, {-3, 9}},
	}
}

// Story 004 criterion 1. The metadata frame is msgpack on the wire, so a field
// that survives a Go copy but not an encode/decode round-trip is invisible here
// and missing in the client.
func TestItemMetaRoundTripsThroughMsgpack(t *testing.T) {
	want := fullItemMeta()

	var got ItemMeta
	decodeLikeTheWire(t, encodeLikeTheWire(t, want), &got)

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ItemMeta did not survive the round trip:\n got %+v\nwant %+v", got, want)
	}
}

// The wire keys ARE the json tags — the frontend interfaces are written against
// them, and there is no version negotiation to absorb a rename. Decoding into a
// generic map is the only way to see the names msgpack actually wrote.
func TestItemMetaWireKeysComeFromJSONTags(t *testing.T) {
	var generic map[string]any
	decodeLikeTheWire(t, encodeLikeTheWire(t, fullItemMeta()), &generic)

	for _, key := range []string{
		"subject", "link", "tier", "confidence", "evidence",
		"participants", "mentions", "provenance", "tags", "peaks",
	} {
		if _, ok := generic[key]; !ok {
			t.Errorf("wire frame has no %q key; got keys %v", key, keysOf(generic))
		}
	}
}

func keysOf(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// Story 004 criterion 3, and the structural half of the redaction boundary that
// video-grabber's public_meta.py opens. `gate_reasons` and `model` are QA signals
// about our own pipeline and must never reach a client. The projection upstream
// is closed — it enumerates what it publishes — and this asserts the Go side is
// closed the same way: there is no field here to decode them INTO, so a future
// producer that adds them to the column cannot leak them through this type.
//
// Walked recursively rather than checked field-by-field on ItemMeta, because the
// signals are stamped at the top level of the private blob and a nested struct
// that grew one would be just as much of a leak.
func TestNoTypeCanCarryTheRedactedSignals(t *testing.T) {
	redacted := map[string]bool{"gate_reasons": true, "model": true}

	walkFields(t, reflect.TypeOf(ItemMeta{}), func(owner reflect.Type, f reflect.StructField, tag string) {
		if redacted[tag] {
			t.Errorf("%s.%s has json tag %q — that is a redacted pipeline signal",
				owner.Name(), f.Name, tag)
		}
	})
}

// Story 004 criterion 2. A `map[string]any` or `any` anywhere in this tree would
// republish whatever the provenance column happened to hold, which is exactly
// the passthrough the closed projection exists to prevent: an upstream mistake
// would become a wire leak instead of being dropped. `map[string]string` is
// allowed — Provenance.Sources is a path→label map whose VALUES are enumerated
// upstream, and it cannot carry a nested object.
func TestNoTypeHasAnUntypedJSONPassthrough(t *testing.T) {
	prov, ok := reflect.TypeOf(ItemMeta{}).FieldByName("Provenance")
	if !ok {
		t.Fatal("ItemMeta has no Provenance field")
	}
	if prov.Type.Kind() != reflect.Ptr || prov.Type.Elem() != reflect.TypeOf(Provenance{}) {
		t.Fatalf("ItemMeta.Provenance is %s, want *model.Provenance", prov.Type)
	}

	anyType := reflect.TypeOf((*any)(nil)).Elem()
	walkFields(t, reflect.TypeOf(ItemMeta{}), func(owner reflect.Type, f reflect.StructField, _ string) {
		for typ := f.Type; ; {
			switch typ.Kind() {
			case reflect.Interface:
				t.Errorf("%s.%s is %s — an untyped passthrough reopens the redaction boundary",
					owner.Name(), f.Name, f.Type)
				return
			case reflect.Ptr, reflect.Slice, reflect.Array:
				typ = typ.Elem()
			case reflect.Map:
				if typ.Elem() == anyType {
					t.Errorf("%s.%s is %s — an untyped passthrough reopens the redaction boundary",
						owner.Name(), f.Name, f.Type)
					return
				}
				typ = typ.Elem()
			default:
				return
			}
		}
	})
}

// Story 004 criterion 5. Namespace is a plain string, not *string: a nil pointer
// and an empty namespace would render identically on the card while comparing
// differently in Go, so the distinction buys nothing and costs a deref at every
// use. The NULL that the column can genuinely hold (curated tags are stored
// verbatim and need not be namespaced) is absorbed by the scanner in
// db.Mp3TagVocabulary, which is where every other nullable text column here is
// handled too.
func TestTagNamespaceIsNotAPointer(t *testing.T) {
	f, ok := reflect.TypeOf(Tag{}).FieldByName("Namespace")
	if !ok {
		t.Fatal("Tag has no Namespace field")
	}
	if f.Type.Kind() != reflect.String {
		t.Fatalf("Tag.Namespace is %s, want string", f.Type)
	}
}

// Story 004 criterion 4 / story 003 criterion 6. mp3_history re-sends the entire
// ~755-item back catalogue on every seek, so a field added to MediaItem is paid
// for once per item per Time Machine scrub — roughly 1.5 MB of msgpack for this
// metadata. Avoiding that is the whole reason ItemMeta exists as a separate type
// on a separate frame. MediaItem is also scanned by queryItems' fixed 20-column
// positional list, shared with news, media and pager selects.
func TestMediaItemDidNotGrowMetadataFields(t *testing.T) {
	want := []string{
		"id", "title", "full_title", "source", "start_date", "end_date",
		"calc_duration", "timezone", "url", "format", "approved", "mute",
		"volume", "jump", "trim", "image", "image_caption", "subtitles",
		"content", "sort",
	}

	mi := reflect.TypeOf(MediaItem{})
	var got []string
	for i := 0; i < mi.NumField(); i++ {
		got = append(got, jsonTag(mi.Field(i)))
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("MediaItem fields changed:\n got %v\nwant %v\n"+
			"queryItems scans these 20 columns positionally; ItemMeta is where mp3 metadata belongs", got, want)
	}
}

func jsonTag(f reflect.StructField) string {
	tag := f.Tag.Get("json")
	if i := len(tag); i > 0 {
		for j := 0; j < i; j++ {
			if tag[j] == ',' {
				return tag[:j]
			}
		}
	}
	return tag
}

// walkFields visits every field of t and of every struct reachable from it.
func walkFields(t *testing.T, typ reflect.Type, fn func(owner reflect.Type, f reflect.StructField, tag string)) {
	t.Helper()
	seen := map[reflect.Type]bool{}

	var walk func(reflect.Type)
	walk = func(s reflect.Type) {
		if s.Kind() != reflect.Struct || seen[s] {
			return
		}
		seen[s] = true
		for i := 0; i < s.NumField(); i++ {
			f := s.Field(i)
			fn(s, f, jsonTag(f))

			elem := f.Type
			for elem.Kind() == reflect.Ptr || elem.Kind() == reflect.Slice ||
				elem.Kind() == reflect.Array || elem.Kind() == reflect.Map {
				elem = elem.Elem()
			}
			walk(elem)
		}
	}
	walk(typ)
}
