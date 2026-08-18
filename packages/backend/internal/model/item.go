package model

import "time"

// MediaItem represents a scheduled broadcast media entry.
type MediaItem struct {
	ID           int        `json:"id"`
	Title        string     `json:"title"`
	FullTitle    string     `json:"full_title"`
	Source       *string    `json:"source,omitempty"`
	StartDate    time.Time  `json:"start_date"`
	EndDate      *time.Time `json:"end_date,omitempty"`
	CalcDuration *int       `json:"calc_duration,omitempty"`
	Timezone     string     `json:"timezone,omitempty"`
	URL          string     `json:"url"`
	Format       string     `json:"format"`
	Approved     int        `json:"approved"`
	Mute         int        `json:"mute"`
	Volume       float64    `json:"volume"`
	Jump         int        `json:"jump"`
	Trim         int        `json:"trim"`
	Image        string     `json:"image,omitempty"`
	ImageCaption string     `json:"image_caption,omitempty"`
	Subtitles    string     `json:"subtitles,omitempty"`
	Content      string     `json:"content,omitempty"`
	Sort         *int       `json:"sort,omitempty"`
}

// Tag is one entry of the mp3 tag vocabulary: a namespaced label (`facility:zob`)
// plus the two halves it splits into and whatever presentation a curator set on
// it. `sort` is deliberately absent — it exists only to order the vocabulary, and
// both queries that produce Tags apply that order themselves, so shipping the
// column would hand the client a second, redundant way to sort the same list.
type Tag struct {
	Tag       string `json:"tag"`
	Namespace string `json:"namespace,omitempty"`
	Value     string `json:"value,omitempty"`
	Color     string `json:"color,omitempty"`
}

// Participant is one party to a recorded conversation.
//
// A stored participant also carries `source`, the per-field provenance label the
// containment gate resolved it against. That is an internal working note about
// our own pipeline, so the projection in video-grabber's public_meta.py rebuilds
// the entry from these five fields rather than copying and trimming — and this
// struct has nowhere to put it either.
type Participant struct {
	Person     string `json:"person,omitempty"`
	Facility   string `json:"facility,omitempty"`
	Position   string `json:"position,omitempty"`
	Role       string `json:"role,omitempty"`
	Confidence string `json:"confidence,omitempty"`
}

// Mentions are the entities a recording names without being party to. All three
// kinds are always present (possibly empty) because the projection always writes
// all three: the card has to be able to say "nobody else was named" definitely.
type Mentions struct {
	Facilities []string `json:"facilities"`
	Aircraft   []string `json:"aircraft"`
	People     []string `json:"people"`
}

// Commission is the 9/11 Commission's own catalogue entry for a recording, when
// there is one. `slug_overlap` — the score of the filename match that found the
// clip — is absent by construction: that is how confident our *matcher* was, a
// pipeline diagnostic rather than a fact about the recording.
type Commission struct {
	Title  string `json:"title,omitempty"`
	Source string `json:"source,omitempty"`
	Stamp  string `json:"stamp,omitempty"`
}

// Provenance says where the published values came from, path by path.
//
// Deliberately a struct rather than a `map[string]any` passthrough of the stored
// provenance JSON. `mp3_items.parties` carries two QA signals — `gate_reasons`
// and `model` — that must never leave the pipeline, and video-grabber's
// public_meta.py is the only place that redaction happens. It is a *closed*
// projection precisely so a field a future producer adds is dropped by default
// rather than published. Typing the Go side the same way keeps that boundary
// closed twice: an `any` here would republish whatever the column happened to
// hold, turning a single mistake upstream into a leak on the wire.
type Provenance struct {
	GeneratedAt string            `json:"generated_at,omitempty"`
	Sources     map[string]string `json:"sources,omitempty"`
	// Nil rather than an empty object: the Commission catalogued only some of
	// these recordings, and "they did not" is worth saying plainly.
	Commission *Commission `json:"commission,omitempty"`
}

// ItemMeta is the Radio Traffic card's view of one mp3 item — who the traffic is
// between, what it is about, how far to trust that, and the waveform envelope.
//
// It is deliberately NOT part of MediaItem. `mp3_history` carries the whole
// ~755-item back catalogue and is re-sent in full on every seek, so a field here
// folded into MediaItem would cost roughly 1.5 MB of msgpack on every Time
// Machine scrub. This metadata is static for the whole session, so it travels
// once on its own frame instead — which is also why db.Mp3Metadata has its own
// scanner rather than widening mp3SelectFrom (see the note there).
type ItemMeta struct {
	Subject      string        `json:"subject,omitempty"`
	Link         string        `json:"link,omitempty"`
	Tier         string        `json:"tier,omitempty"`
	Confidence   string        `json:"confidence,omitempty"`
	Evidence     string        `json:"evidence,omitempty"`
	Participants []Participant `json:"participants,omitempty"`
	Mentions     *Mentions     `json:"mentions,omitempty"`
	Provenance   *Provenance   `json:"provenance,omitempty"`
	// No omitempty: an item with no tags must still send an empty list, so the
	// client can tell "nothing is tagged" from "the field is missing".
	Tags []Tag `json:"tags"`
	// 480 [min, max] pairs scaled to -128..127 — the fixed-bucket amplitude
	// envelope video-grabber's peaks pipeline writes. int8 rather than int keeps
	// the msgpack encoding one byte per value.
	Peaks [][2]int8 `json:"peaks,omitempty"`
}

// AlertItem is a background alert. It reuses the full MediaItem shape (headline in
// Title, HTML body in Content, plus Image/ImageCaption/StartDate) and adds Severity,
// which selects the ClassicyAlert icon (note | caution | stop). Embedding keeps
// MediaItem — and every other channel's SELECT — untouched by the alert-only column.
type AlertItem struct {
	MediaItem
	Severity *string `json:"severity,omitempty"`
}
