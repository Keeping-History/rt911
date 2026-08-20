# IM Buddies — Plan C: Knowledge & Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a buddy profile and a virtual clock position into a finished, provider-neutral prompt — three-tier knowledge retrieval plus pure prompt assembly, with no LLM call anywhere.

**Architecture:** Three additions to the existing `packages/backend/internal/chat/` package. `beacon.go` resolves which emotional phase a profile is in at a given time. `knowledge.go` retrieves passages from the three tiers with provenance attached. `composer.go` renders everything into ordered, stability-tagged prompt segments. The retrieval SQL is thin; every decision that matters lives in pure functions that are exhaustively testable without a database.

**Tech Stack:** Go 1.25, `jackc/pgx/v5`. No new dependencies. No network calls.

## Global Constraints

- Module is `classicy/streamer`; all non-entry code lives under `internal/`.
- **All times are UTC `time.Time`.** Never compare formatted time strings.
- **The three tiers disagree about column type, and Go will not raise about it.** `chat_knowledge.public_at`/`until` and `chat_transcript_segments.start_date`/`end_date` are `timestamp with time zone`; `news_items.start_date` is `timestamp without time zone`. Every scanned time must be normalized with `.UTC()` at the scan site. In Python this bug class raises; in Go a mis-located timestamp compares silently wrong, which is worse.
- **Nullable text columns scan into `*string`** — Directus emits `NULL` for empty strings and pgx cannot scan `NULL` into a non-pointer string.
- **`Compose` and every helper it calls must be pure** — no I/O, no clock reads, no randomness. It is the piece that will be iterated on most, and its testability is the point.
- **Retrieval is bounded by the clock, not by relevance ranking.** Tier 1 is cumulative up to `T`; tier 2 is a fixed lookback window ending at `T`; tier 3 is a search that is only consulted on a miss. Nothing may return a passage dated after `T`.
- **Import groups:** stdlib, then `classicy/streamer/...`, then third-party.
- **No comments that restate the code.** Comments explain *why*.
- Run `go build ./... && go vet ./... && go test ./...` and `gofmt -l ./internal/` from `packages/backend/` before every commit.

---

### Task 1: Beacon and phase resolution

**Files:**
- Create: `packages/backend/internal/chat/beacon.go`
- Create: `packages/backend/internal/chat/beacon_test.go`

**Interfaces:**
- Consumes: nothing from earlier plans beyond the existing package.
- Produces:
  - `Beacon` — `ID int`, `Key string`, `Label string`, `At time.Time`, `PublicAt time.Time`
  - `Phase` — `ID int`, `ProfileID int`, `FromBeacon *int`, `Tone string`, `Shock`, `Coherence`, `Verbosity`, `TypoRate`, `TopicFocus int`, `Sort int`
  - `func PhaseAt(phases []Phase, beacons map[int]Beacon, t time.Time) (Phase, bool)`
  - `func LoadBeacons(ctx context.Context, pool *pgxpool.Pool) (map[int]Beacon, error)`
  - `func LoadPhases(ctx context.Context, pool *pgxpool.Pool) (map[int][]Phase, error)` — keyed by profile id

- [ ] **Step 1: Write the failing tests**

Create `packages/backend/internal/chat/beacon_test.go`:

```go
package chat

import (
	"testing"
	"time"
)

func beaconSet() map[int]Beacon {
	return map[int]Beacon{
		1: {ID: 1, Key: "first_impact", At: at("12:46"), PublicAt: at("12:51")},
		2: {ID: 2, Key: "second_impact", At: at("13:03"), PublicAt: at("13:03")},
	}
}

func phases() []Phase {
	one, two := 1, 2
	return []Phase{
		{ID: 10, ProfileID: 1, FromBeacon: nil, Tone: "ordinary morning", Sort: 0, Shock: 0},
		{ID: 11, ProfileID: 1, FromBeacon: &one, Tone: "confused", Sort: 1, Shock: 30},
		{ID: 12, ProfileID: 1, FromBeacon: &two, Tone: "frightened", Sort: 2, Shock: 80},
	}
}

func TestPhaseAtUsesPublicAtNotAt(t *testing.T) {
	// The north tower was struck at 12:46Z but was not on air until 12:51Z. A
	// buddy cannot react to an event they have not heard about, so the phase
	// must not advance until public_at.
	got, ok := PhaseAt(phases(), beaconSet(), at("12:48"))
	if !ok {
		t.Fatal("expected a phase")
	}
	if got.ID != 10 {
		t.Fatalf("phase %d at 12:48 — must still be the opening phase until public_at", got.ID)
	}

	got, _ = PhaseAt(phases(), beaconSet(), at("12:51"))
	if got.ID != 11 {
		t.Fatalf("phase %d at public_at — the beacon phase must be active from public_at inclusive", got.ID)
	}
}

func TestPhaseAtPicksTheLatestReachedBeacon(t *testing.T) {
	got, _ := PhaseAt(phases(), beaconSet(), at("14:00"))
	if got.ID != 12 {
		t.Fatalf("phase = %d, want 12 (both beacons passed)", got.ID)
	}
}

func TestPhaseAtBeforeAnyBeaconUsesTheNilBeaconPhase(t *testing.T) {
	got, ok := PhaseAt(phases(), beaconSet(), at("12:05"))
	if !ok || got.ID != 10 {
		t.Fatalf("got (%d, %v), want the FromBeacon=nil phase", got.ID, ok)
	}
}

func TestPhaseAtWithNoPhasesReturnsFalse(t *testing.T) {
	if _, ok := PhaseAt(nil, beaconSet(), at("14:00")); ok {
		t.Fatal("no phases configured must report false, not a zero Phase")
	}
}

func TestPhaseAtIgnoresAPhaseWhoseBeaconIsMissing(t *testing.T) {
	// A phase pointing at a deleted beacon must not silently win by sort order;
	// it is unresolvable and is skipped.
	ghost := 99
	ps := append(phases(), Phase{ID: 13, ProfileID: 1, FromBeacon: &ghost, Sort: 3})
	got, _ := PhaseAt(ps, beaconSet(), at("14:00"))
	if got.ID != 12 {
		t.Fatalf("phase = %d, want 12 — a phase with a missing beacon must be skipped", got.ID)
	}
}

func TestPhaseAtOutsideTheWindowStillResolves(t *testing.T) {
	// Availability gating is Gate's job, not PhaseAt's. Resolving a phase for a
	// time outside the chat window is legitimate — a seek can land anywhere.
	if _, ok := PhaseAt(phases(), beaconSet(), mustParse("2001-09-10T12:00:00Z")); !ok {
		t.Fatal("PhaseAt must resolve regardless of the chat window")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/backend && go test ./internal/chat/... -run TestPhaseAt -v`
Expected: FAIL — `undefined: Beacon`.

- [ ] **Step 3: Write the implementation**

Create `packages/backend/internal/chat/beacon.go`:

```go
package chat

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Beacon is a named story anchor. It carries two clocks deliberately: At is when
// the event happened, PublicAt is when it became publicly known. The Pentagon was
// struck several minutes before it was on air, and a buddy's mood cannot change
// from an event they have not heard about — so phases advance on PublicAt and
// only the curated knowledge tier uses At.
type Beacon struct {
	ID       int
	Key      string
	Label    string
	At       time.Time
	PublicAt time.Time
}

// Phase is one step of a profile's emotional arc, anchored to a beacon. The
// dials are rendered into prompt language by the composer; the model never sees
// the numbers.
type Phase struct {
	ID         int
	ProfileID  int
	FromBeacon *int
	Tone       string
	Shock      int
	Coherence  int
	Verbosity  int
	TypoRate   int
	TopicFocus int
	Sort       int
}

// PhaseAt returns the phase in effect at virtual time t: the one whose beacon
// has most recently become public. A phase with no beacon is the opening state.
//
// It resolves for any t, including outside the chat window — deciding whether
// chat is usable at all is Gate's job, and a seek can land anywhere.
func PhaseAt(phases []Phase, beacons map[int]Beacon, t time.Time) (Phase, bool) {
	var best Phase
	var bestAt time.Time
	found := false

	for _, p := range phases {
		var reachedAt time.Time
		if p.FromBeacon != nil {
			b, ok := beacons[*p.FromBeacon]
			if !ok {
				// Unresolvable: a phase pointing at a deleted beacon must not win
				// by sort order and silently misrepresent the arc.
				continue
			}
			if t.Before(b.PublicAt) {
				continue
			}
			reachedAt = b.PublicAt
		}

		if !found || reachedAt.After(bestAt) ||
			(reachedAt.Equal(bestAt) && p.Sort > best.Sort) {
			best, bestAt, found = p, reachedAt, true
		}
	}
	return best, found
}

const beaconSelect = `SELECT id, key, label, at, public_at FROM chat_beacons`

// LoadBeacons reads every beacon, keyed by id for phase resolution. Config is
// tiny and static, so callers load once and keep the map.
func LoadBeacons(ctx context.Context, pool *pgxpool.Pool) (map[int]Beacon, error) {
	rows, err := pool.Query(ctx, beaconSelect)
	if err != nil {
		return nil, fmt.Errorf("query chat_beacons: %w", err)
	}
	defer rows.Close()

	out := make(map[int]Beacon)
	for rows.Next() {
		var (
			b     Beacon
			label *string
		)
		if err := rows.Scan(&b.ID, &b.Key, &label, &b.At, &b.PublicAt); err != nil {
			return nil, fmt.Errorf("scan chat_beacons: %w", err)
		}
		b.Label = derefStr(label)
		// These columns are timestamptz; every other time in this package is
		// UTC, and a differently-located time compares silently wrong.
		b.At, b.PublicAt = b.At.UTC(), b.PublicAt.UTC()
		out[b.ID] = b
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate chat_beacons: %w", err)
	}
	return out, nil
}

const phaseSelect = `
	SELECT id, profile, from_beacon, tone, shock, coherence, verbosity, typo_rate, topic_focus, sort
	FROM chat_phases
	ORDER BY profile, sort`

// LoadPhases reads every phase, grouped by profile id.
func LoadPhases(ctx context.Context, pool *pgxpool.Pool) (map[int][]Phase, error) {
	rows, err := pool.Query(ctx, phaseSelect)
	if err != nil {
		return nil, fmt.Errorf("query chat_phases: %w", err)
	}
	defer rows.Close()

	out := make(map[int][]Phase)
	for rows.Next() {
		var (
			p    Phase
			tone *string
		)
		if err := rows.Scan(&p.ID, &p.ProfileID, &p.FromBeacon, &tone,
			&p.Shock, &p.Coherence, &p.Verbosity, &p.TypoRate, &p.TopicFocus, &p.Sort); err != nil {
			return nil, fmt.Errorf("scan chat_phases: %w", err)
		}
		p.Tone = derefStr(tone)
		out[p.ProfileID] = append(out[p.ProfileID], p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate chat_phases: %w", err)
	}
	for id := range out {
		sort.SliceStable(out[id], func(i, j int) bool { return out[id][i].Sort < out[id][j].Sort })
	}
	return out, nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/backend && go test ./internal/chat/... -v`
Expected: PASS, including the pre-existing profile and availability tests.

- [ ] **Step 5: Verify and commit**

Run: `cd packages/backend && gofmt -l ./internal/ && go build ./... && go vet ./... && go test ./...`
Expected: no gofmt output; everything passes.

```bash
git add packages/backend/internal/chat/beacon.go packages/backend/internal/chat/beacon_test.go
git commit -m "feat(chat): resolve emotional phase from story beacons"
```

---

### Task 2: Three-tier knowledge retrieval

**Files:**
- Create: `packages/backend/internal/chat/knowledge.go`
- Create: `packages/backend/internal/chat/knowledge_test.go`

**Interfaces:**
- Consumes: `derefStr` from `profile.go`.
- Produces:
  - `Tier` — `TierCurated`, `TierBroadcast`, `TierTimeline` (ints 1..3)
  - `Passage` — `Tier Tier`, `At time.Time`, `Text string`, `Certainty string`, `Sensitivity string`
  - `func Redact(passages []Passage) []Passage`
  - `func Budget(passages []Passage, maxRunes int) []Passage`
  - `func LoadCurated(ctx, pool, t) ([]Passage, error)`
  - `func LoadBroadcast(ctx, pool, t, lookback, channelIDs) ([]Passage, error)`
  - `func SearchTimeline(ctx, pool, t, query, limit) ([]Passage, error)`

- [ ] **Step 1: Write the failing tests**

Create `packages/backend/internal/chat/knowledge_test.go`:

```go
package chat

import (
	"strings"
	"testing"
)

func TestRedactDropsDoNotDiscussEntirely(t *testing.T) {
	in := []Passage{
		{Tier: TierCurated, Text: "keep", Sensitivity: "normal"},
		{Tier: TierCurated, Text: "drop", Sensitivity: "do_not_discuss"},
		{Tier: TierCurated, Text: "keep too", Sensitivity: "handle_with_care"},
	}
	got := Redact(in)
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
	for _, p := range got {
		if p.Text == "drop" {
			t.Fatal("a do_not_discuss passage must never reach the prompt")
		}
	}
}

func TestBudgetDropsLowestTierFirst(t *testing.T) {
	// Tier 1 is authored and authoritative; tier 3 is retrospective and only a
	// fallback. Under pressure the fallback goes first.
	in := []Passage{
		{Tier: TierTimeline, Text: strings.Repeat("c", 100)},
		{Tier: TierCurated, Text: strings.Repeat("a", 100)},
		{Tier: TierBroadcast, Text: strings.Repeat("b", 100)},
	}
	got := Budget(in, 250)

	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
	for _, p := range got {
		if p.Tier == TierTimeline {
			t.Fatal("tier 3 must be dropped before tiers 1 and 2")
		}
	}
}

func TestBudgetKeepsTierOrderStable(t *testing.T) {
	in := []Passage{
		{Tier: TierBroadcast, Text: "b"},
		{Tier: TierCurated, Text: "a1"},
		{Tier: TierCurated, Text: "a2"},
	}
	got := Budget(in, 1000)

	if len(got) != 3 {
		t.Fatalf("len = %d, want 3 — nothing should be dropped under a large budget", len(got))
	}
	if got[0].Tier != TierCurated || got[1].Tier != TierCurated || got[2].Tier != TierBroadcast {
		t.Fatal("passages must be ordered by tier so the composer can label provenance")
	}
	if got[0].Text != "a1" || got[1].Text != "a2" {
		t.Fatal("order within a tier must be preserved")
	}
}

func TestBudgetStopsAtTheFirstOverBudgetPassage(t *testing.T) {
	// It must not skip past a large tier-2 passage to squeeze in a small tier-3
	// one — that would keep the less authoritative source and drop the more
	// authoritative one, which is backwards.
	in := []Passage{
		{Tier: TierCurated, Text: strings.Repeat("a", 50)},
		{Tier: TierBroadcast, Text: strings.Repeat("b", 300)},
		{Tier: TierTimeline, Text: "tiny"},
	}
	got := Budget(in, 200)

	if len(got) != 1 || got[0].Tier != TierCurated {
		t.Fatalf("got %d passages (first tier %v), want only the tier-1 one", len(got), got[0].Tier)
	}
}

func TestBudgetNeverDropsEveryPassage(t *testing.T) {
	// An impossible budget must still yield the single most authoritative
	// passage rather than an empty prompt, which would read as "knows nothing".
	in := []Passage{
		{Tier: TierCurated, Text: strings.Repeat("a", 500)},
		{Tier: TierBroadcast, Text: strings.Repeat("b", 500)},
	}
	got := Budget(in, 10)
	if len(got) != 1 || got[0].Tier != TierCurated {
		t.Fatalf("got %d passages, want exactly the tier-1 one", len(got))
	}
}

func TestBudgetWithNoPassagesIsEmptyNotNil(t *testing.T) {
	if got := Budget(nil, 100); got == nil || len(got) != 0 {
		t.Fatalf("got %v, want an empty non-nil slice", got)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/backend && go test ./internal/chat/... -run 'TestRedact|TestBudget' -v`
Expected: FAIL — `undefined: Passage`.

- [ ] **Step 3: Write the implementation**

Create `packages/backend/internal/chat/knowledge.go`:

```go
package chat

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Tier records where a passage came from, which decides how the composer is
// allowed to use it: tier 1 is authored and may be stated plainly (hedged by
// its certainty), tier 2 is what was actually broadcast, and tier 3 is a
// retrospective investigative timeline that must only ever be paraphrased
// vaguely — a civilian in 2001 did not know what it records.
type Tier int

const (
	TierCurated   Tier = 1
	TierBroadcast Tier = 2
	TierTimeline  Tier = 3
)

// Passage is one retrieved piece of knowledge with its provenance attached.
type Passage struct {
	Tier        Tier
	At          time.Time
	Text        string
	Certainty   string
	Sensitivity string
}

// Redact removes passages the curator marked as off limits. This runs before
// anything reaches a prompt, so a do_not_discuss row cannot be paraphrased into
// the conversation by a model that was never shown it.
func Redact(passages []Passage) []Passage {
	out := make([]Passage, 0, len(passages))
	for _, p := range passages {
		if p.Sensitivity == "do_not_discuss" {
			continue
		}
		out = append(out, p)
	}
	return out
}

// Budget orders passages by tier and trims to fit maxRunes, dropping the least
// authoritative first. It always returns at least one passage when given one:
// an empty knowledge block reads to the model as "this buddy knows nothing",
// which is a worse failure than a truncated one.
func Budget(passages []Passage, maxRunes int) []Passage {
	ordered := make([]Passage, len(passages))
	copy(ordered, passages)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Tier < ordered[j].Tier })

	out := make([]Passage, 0, len(ordered))
	used := 0
	for _, p := range ordered {
		n := len([]rune(p.Text))
		// break, not continue: skipping past an over-budget passage to fit a
		// later smaller one would keep a less authoritative tier while dropping
		// a more authoritative one, inverting the rule this function exists for.
		if len(out) > 0 && used+n > maxRunes {
			break
		}
		out = append(out, p)
		used += n
	}
	return out
}

const curatedSelect = `
	SELECT public_at, summary, detail, certainty, sensitivity
	FROM chat_knowledge
	WHERE public_at <= $1 AND (until IS NULL OR until > $1)
	ORDER BY public_at`

// LoadCurated returns every curated entry that was public at t and has not been
// superseded. It is cumulative rather than a window: this is the running digest
// of what an ordinary person knew by now, and it is the tier the composer is
// allowed to state plainly.
func LoadCurated(ctx context.Context, pool *pgxpool.Pool, t time.Time) ([]Passage, error) {
	rows, err := pool.Query(ctx, curatedSelect, t.UTC())
	if err != nil {
		return nil, fmt.Errorf("query chat_knowledge: %w", err)
	}
	defer rows.Close()

	var out []Passage
	for rows.Next() {
		var (
			p      Passage
			detail *string
		)
		if err := rows.Scan(&p.At, &p.Text, &detail, &p.Certainty, &p.Sensitivity); err != nil {
			return nil, fmt.Errorf("scan chat_knowledge: %w", err)
		}
		if d := derefStr(detail); d != "" {
			p.Text = p.Text + " " + d
		}
		p.Tier = TierCurated
		p.At = p.At.UTC()
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate chat_knowledge: %w", err)
	}
	return out, nil
}

const broadcastSelect = `
	SELECT start_date, text
	FROM chat_transcript_segments
	WHERE start_date > $1 AND start_date <= $2
	  AND ($3::int[] IS NULL OR channel = ANY($3::int[]))
	ORDER BY start_date`

// LoadBroadcast returns transcript segments from the lookback window ending at
// t, optionally restricted to the channels the user is actually watching. This
// is what the buddy could have heard just now, and it is why the early-morning
// confusion ("they're saying it was a small plane") appears without being
// authored.
func LoadBroadcast(ctx context.Context, pool *pgxpool.Pool, t time.Time, lookback time.Duration, channelIDs []int) ([]Passage, error) {
	var ids any
	if len(channelIDs) > 0 {
		ids = channelIDs
	}
	rows, err := pool.Query(ctx, broadcastSelect, t.UTC().Add(-lookback), t.UTC(), ids)
	if err != nil {
		return nil, fmt.Errorf("query chat_transcript_segments: %w", err)
	}
	defer rows.Close()

	var out []Passage
	for rows.Next() {
		var p Passage
		if err := rows.Scan(&p.At, &p.Text); err != nil {
			return nil, fmt.Errorf("scan chat_transcript_segments: %w", err)
		}
		p.Tier = TierBroadcast
		p.Certainty = "reported"
		p.Sensitivity = "normal"
		p.At = p.At.UTC()
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate chat_transcript_segments: %w", err)
	}
	return out, nil
}

const timelineSearch = `
	SELECT start_date, title, content
	FROM news_items
	WHERE approved = 1 AND start_date <= $1
	  AND to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, ''))
	      @@ plainto_tsquery('english', $2)
	ORDER BY start_date DESC
	LIMIT $3`

// SearchTimeline is the tier-3 fallback, consulted only when tiers 1 and 2 miss.
// news_items is the History Commons investigative timeline: accurate about what
// happened, but written with hindsight and full of detail no civilian had in
// 2001. The composer must paraphrase it vaguely, never quote it.
//
// news_items.start_date is `timestamp without time zone` while the other two
// tiers are timestamptz, so the scanned value is forced to UTC like the rest.
func SearchTimeline(ctx context.Context, pool *pgxpool.Pool, t time.Time, query string, limit int) ([]Passage, error) {
	rows, err := pool.Query(ctx, timelineSearch, t.UTC(), query, limit)
	if err != nil {
		return nil, fmt.Errorf("query news_items: %w", err)
	}
	defer rows.Close()

	var out []Passage
	for rows.Next() {
		var (
			p       Passage
			title   *string
			content *string
		)
		if err := rows.Scan(&p.At, &title, &content); err != nil {
			return nil, fmt.Errorf("scan news_items: %w", err)
		}
		p.Text = derefStr(title)
		if c := derefStr(content); c != "" {
			p.Text = p.Text + " " + c
		}
		p.Tier = TierTimeline
		p.Certainty = "confirmed"
		p.Sensitivity = "handle_with_care"
		p.At = p.At.UTC()
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate news_items: %w", err)
	}
	return out, nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/backend && go test ./internal/chat/... -v`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `cd packages/backend && gofmt -l ./internal/ && go build ./... && go vet ./... && go test ./...`

```bash
git add packages/backend/internal/chat/knowledge.go packages/backend/internal/chat/knowledge_test.go
git commit -m "feat(chat): add three-tier knowledge retrieval"
```

---

### Task 3: The composer

**Files:**
- Create: `packages/backend/internal/chat/composer.go`
- Create: `packages/backend/internal/chat/composer_test.go`

**Interfaces:**
- Consumes: `Profile`, `Phase`, `Passage`, `Tier` from earlier tasks.
- **Also modifies `profile.go`** — see Step 0. Plan A loaded only the identity and availability
  fields and left a comment saying persona and style arrive "in a later plan". This is that plan,
  and the composer will not compile without them.
- Produces:
  - `Stability` — `StabilityStable`, `StabilityAppendOnly`, `StabilityVolatile`
  - `PromptSegment` — `Stability Stability`, `Role string` (`system` or `user`), `Text string`
  - `Turn` — `FromBuddy bool`, `Text string`
  - `ComposeInput` — `Profile Profile`, `Phase Phase`, `Digest []Passage`, `Recent []Passage`, `History []Turn`, `VirtualTime time.Time`, `UserMessage string`
  - `func Compose(in ComposeInput) []PromptSegment`

- [ ] **Step 0: Add the persona fields to `Profile`**

`chat.Profile` currently carries only identity and availability — `persona`, `writing_style`, and
`style_exemplars` exist as columns in `chat_profiles` but were deliberately not loaded by Plan A.
The composer needs them.

In `packages/backend/internal/chat/profile.go`, add to the `Profile` struct after `Avatar`:

```go
	Persona        string
	EducationLevel string
	WritingStyle   string
	StyleExemplars string
```

Extend `profileSelect` to match, keeping the SELECT list and the `rows.Scan` call in the same order —
they are positional and a mismatch is silent:

```go
const profileSelect = `
	SELECT id, screen_name, display_name, avatar, persona, education_level,
	       writing_style, style_exemplars, online_from, online_until, sort
	FROM chat_profiles
	WHERE active = 1
	ORDER BY sort, id`
```

All four new columns are nullable, so scan each into a `*string` local and `derefStr` it, exactly as
`display_name` and `avatar` already are:

```go
		var (
			p              Profile
			displayName    *string
			avatar         *string
			persona        *string
			educationLevel *string
			writingStyle   *string
			styleExemplars *string
		)
		if err := rows.Scan(&p.ID, &p.ScreenName, &displayName, &avatar,
			&persona, &educationLevel, &writingStyle, &styleExemplars,
			&p.OnlineFrom, &p.OnlineUntil, &p.Sort); err != nil {
			return nil, fmt.Errorf("scan chat_profiles: %w", err)
		}
		p.DisplayName = derefStr(displayName)
		p.Avatar = derefStr(avatar)
		p.Persona = derefStr(persona)
		p.EducationLevel = derefStr(educationLevel)
		p.WritingStyle = derefStr(writingStyle)
		p.StyleExemplars = derefStr(styleExemplars)
```

The pre-existing `profile_test.go` tests must still pass untouched — they build `Profile` values by
field name and never call `LoadProfiles`, so adding fields cannot break them. If any of them fails,
stop and report rather than editing the test.

- [ ] **Step 1: Write the failing tests**

Create `packages/backend/internal/chat/composer_test.go`:

```go
package chat

import (
	"strings"
	"testing"
)

func composeInput() ComposeInput {
	return ComposeInput{
		Profile: Profile{ScreenName: "skaterboi1988", DisplayName: "Danny"},
		Phase:   Phase{Tone: "rattled", Shock: 70, Coherence: 40, Verbosity: 20, TypoRate: 60, TopicFocus: 90},
		Digest: []Passage{
			{Tier: TierCurated, Text: "a plane hit the north tower", Certainty: "reported"},
		},
		Recent: []Passage{
			{Tier: TierBroadcast, Text: "we are getting reports of a second aircraft"},
		},
		History:     []Turn{{FromBuddy: false, Text: "are you seeing this"}, {FromBuddy: true, Text: "yeah"}},
		VirtualTime: at("13:10"),
		UserMessage: "is your mom ok",
	}
}

func TestComposeOrdersSegmentsByStability(t *testing.T) {
	got := Compose(composeInput())

	if len(got) < 3 {
		t.Fatalf("got %d segments, want at least persona, digest and the live turn", len(got))
	}
	if got[0].Stability != StabilityStable {
		t.Fatal("the stable persona block must come first so it can be cached")
	}
	if got[len(got)-1].Stability != StabilityVolatile {
		t.Fatal("the per-turn block must come last so it never invalidates the cached prefix")
	}

	// Stability must be non-increasing across the sequence, or a cache
	// breakpoint placed at a boundary would sit in front of volatile content.
	for i := 1; i < len(got); i++ {
		if got[i].Stability < got[i-1].Stability {
			t.Fatalf("segment %d (%v) is more stable than its predecessor (%v)", i, got[i].Stability, got[i-1].Stability)
		}
	}
}

func TestComposeNeverPutsTheClockInTheStableBlock(t *testing.T) {
	// The clock changes every turn. In the system block it would invalidate the
	// whole cached prefix on every message, which is the single most expensive
	// mistake available here.
	got := Compose(composeInput())
	for _, seg := range got {
		if seg.Stability == StabilityStable && strings.Contains(seg.Text, "13:10") {
			t.Fatal("the virtual clock must not appear in a stable segment")
		}
	}
}

func TestComposeRendersDialsAsLanguageNotNumbers(t *testing.T) {
	got := Compose(composeInput())
	joined := allText(got)
	if strings.Contains(joined, "70") || strings.Contains(joined, "Shock") {
		t.Fatal("dials must be rendered into prompt language, never emitted as raw numbers")
	}
	if !strings.Contains(strings.ToLower(joined), "rattled") {
		t.Fatal("the phase's prose tone must reach the prompt")
	}
}

func TestComposeLabelsTierThreeAsUncertain(t *testing.T) {
	in := composeInput()
	in.Digest = append(in.Digest, Passage{
		Tier: TierTimeline, Text: "NEADS scrambles fighters from Otis", Certainty: "confirmed",
	})
	got := Compose(in)
	joined := allText(got)

	if !strings.Contains(joined, "NEADS") {
		t.Fatal("tier 3 content should still be available to the model")
	}
	if !strings.Contains(strings.ToLower(joined), "vague") &&
		!strings.Contains(strings.ToLower(joined), "do not quote") {
		t.Fatal("tier 3 must carry an instruction to paraphrase vaguely — it is hindsight a civilian lacked")
	}
}

func TestComposeIncludesTheUserMessageLast(t *testing.T) {
	got := Compose(composeInput())
	last := got[len(got)-1]
	if !strings.Contains(last.Text, "is your mom ok") {
		t.Fatal("the user's message must be in the final segment")
	}
	if last.Role != "user" {
		t.Fatalf("final segment role = %q, want user", last.Role)
	}
}

func TestComposeWithNoKnowledgeIsStillUsable(t *testing.T) {
	in := composeInput()
	in.Digest, in.Recent = nil, nil
	got := Compose(in)

	if len(got) < 2 {
		t.Fatalf("got %d segments — an empty knowledge set must still yield a usable prompt", len(got))
	}
	if !strings.Contains(allText(got), "is your mom ok") {
		t.Fatal("the user's message must survive an empty knowledge set")
	}
}

func TestComposeIsPure(t *testing.T) {
	in := composeInput()
	a, b := Compose(in), Compose(in)
	if allText(a) != allText(b) {
		t.Fatal("Compose must be deterministic — same input, same prompt")
	}
	if len(in.Digest) != 1 || len(in.History) != 2 {
		t.Fatal("Compose must not mutate its input")
	}
}

func allText(segs []PromptSegment) string {
	var b strings.Builder
	for _, s := range segs {
		b.WriteString(s.Text)
		b.WriteString("\n")
	}
	return b.String()
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/backend && go test ./internal/chat/... -run TestCompose -v`
Expected: FAIL — `undefined: ComposeInput`.

- [ ] **Step 3: Write the implementation**

Create `packages/backend/internal/chat/composer.go`:

```go
package chat

import (
	"fmt"
	"strings"
	"time"
)

// Stability tells the provider adapter where a cache breakpoint may go. Every
// provider caches on a prefix match, so the ordering below is what pays off
// everywhere; only the explicit breakpoint markers are Anthropic-specific.
type Stability int

const (
	StabilityStable     Stability = 0 // per-profile, unchanged for the life of the conversation
	StabilityAppendOnly Stability = 1 // grows forward only, never rewritten
	StabilityVolatile   Stability = 2 // differs every turn
)

// PromptSegment is one ordered piece of the prompt. Compose emits these rather
// than a finished vendor payload so a single composer serves every provider.
type PromptSegment struct {
	Stability Stability
	Role      string
	Text      string
}

// Turn is one prior message in the conversation.
type Turn struct {
	FromBuddy bool
	Text      string
}

// ComposeInput is everything needed to build a prompt. It carries no clock and
// no connection: Compose is pure, which is what makes the prompt exhaustively
// testable without a database or a network.
type ComposeInput struct {
	Profile     Profile
	Phase       Phase
	Digest      []Passage
	Recent      []Passage
	History     []Turn
	VirtualTime time.Time
	UserMessage string
}

// Compose renders the prompt as ordered, stability-tagged segments.
//
// The ordering is the load-bearing part: stable content first, append-only
// next, volatile last. The virtual clock and the user's message must never
// appear in a stable segment — they change every turn, and at the front of the
// prefix they would invalidate the entire cache on every message.
func Compose(in ComposeInput) []PromptSegment {
	segs := []PromptSegment{{
		Stability: StabilityStable,
		Role:      "system",
		Text:      persona(in.Profile),
	}}

	if len(in.Digest) > 0 {
		segs = append(segs, PromptSegment{
			Stability: StabilityAppendOnly,
			Role:      "user",
			Text:      knowledgeBlock(in.Digest),
		})
	}
	if len(in.Recent) > 0 {
		segs = append(segs, PromptSegment{
			Stability: StabilityVolatile,
			Role:      "user",
			Text:      "What you have just heard on TV:\n" + passageLines(in.Recent),
		})
	}
	if len(in.History) > 0 {
		segs = append(segs, PromptSegment{
			Stability: StabilityAppendOnly,
			Role:      "user",
			Text:      historyBlock(in.Profile, in.History),
		})
	}

	segs = append(segs, PromptSegment{
		Stability: StabilityVolatile,
		Role:      "user",
		Text:      liveTurn(in),
	})
	return segs
}

func persona(p Profile) string {
	var b strings.Builder
	fmt.Fprintf(&b, "You are %s", p.ScreenName)
	if p.DisplayName != "" {
		fmt.Fprintf(&b, " (%s)", p.DisplayName)
	}
	b.WriteString(", a real person on an instant messaging service in 2001.\n")
	if p.Persona != "" {
		b.WriteString(p.Persona + "\n")
	}
	if p.EducationLevel != "" {
		fmt.Fprintf(&b, "You write like someone at a %s education level.\n", p.EducationLevel)
	}
	if p.WritingStyle != "" {
		b.WriteString(p.WritingStyle + "\n")
	}
	if p.StyleExemplars != "" {
		b.WriteString("Messages you have sent before, for voice:\n" + p.StyleExemplars + "\n")
	}
	b.WriteString(
		"Write only plain text. No markdown, no formatting, no unicode emoji — " +
			"text emoticons like :-) and :-/ only. Never mention being an AI. " +
			"If you do not know something, say so the way a person would.\n")
	return b.String()
}

// knowledgeBlock renders the cumulative digest. Tier 3 carries an explicit
// instruction because it is retrospective: it records what investigators later
// established, much of it not public until years afterwards, so stating it
// plainly would make the buddy sound like a documentary rather than a person.
func knowledgeBlock(passages []Passage) string {
	var b strings.Builder
	b.WriteString("What you know so far:\n")
	b.WriteString(passageLines(passages))
	for _, p := range passages {
		if p.Tier == TierTimeline {
			b.WriteString(
				"\nSome of the above is background you only half-heard. Refer to anything " +
					"marked uncertain vaguely and do not quote it.\n")
			break
		}
	}
	return b.String()
}

func passageLines(passages []Passage) string {
	var b strings.Builder
	for _, p := range passages {
		switch {
		case p.Tier == TierTimeline:
			fmt.Fprintf(&b, "- (uncertain) %s\n", p.Text)
		case p.Certainty == "rumor":
			fmt.Fprintf(&b, "- (people are saying) %s\n", p.Text)
		default:
			fmt.Fprintf(&b, "- %s\n", p.Text)
		}
	}
	return b.String()
}

func historyBlock(p Profile, turns []Turn) string {
	var b strings.Builder
	b.WriteString("Your conversation so far:\n")
	for _, t := range turns {
		who := "them"
		if t.FromBuddy {
			who = p.ScreenName
		}
		fmt.Fprintf(&b, "%s: %s\n", who, t.Text)
	}
	return b.String()
}

// liveTurn holds everything that changes every message: the clock, the phase
// directive, and what the user just said.
func liveTurn(in ComposeInput) string {
	var b strings.Builder
	fmt.Fprintf(&b, "It is %s.\n", in.VirtualTime.Format("3:04 PM"))
	if d := dialDirective(in.Phase); d != "" {
		b.WriteString(d + "\n")
	}
	fmt.Fprintf(&b, "They just said: %s\n", in.UserMessage)
	b.WriteString("Reply as one short instant message.\n")
	return b.String()
}

// dialDirective renders the numeric dials into language. The model never sees a
// number — "70" means nothing to it, while "badly shaken" does.
func dialDirective(p Phase) string {
	var parts []string
	if p.Tone != "" {
		parts = append(parts, "You feel "+p.Tone+".")
	}
	parts = append(parts, band(p.Shock,
		"You are not especially worried.",
		"You are unsettled.",
		"You are badly shaken."))
	parts = append(parts, band(p.Coherence,
		"You are struggling to finish a thought.",
		"You are a little scattered.",
		"You are thinking clearly."))
	parts = append(parts, band(p.Verbosity,
		"Answer in a few words.",
		"Answer in a sentence.",
		"Answer in two or three sentences."))
	parts = append(parts, band(p.TypoRate,
		"Your typing is clean.",
		"You make the occasional typo.",
		"You are typing fast and making mistakes."))
	parts = append(parts, band(p.TopicFocus,
		"You are talking about ordinary things.",
		"You drift between ordinary things and the news.",
		"You can only talk about what is happening."))
	return strings.Join(parts, " ")
}

func band(v int, low, mid, high string) string {
	switch {
	case v < 34:
		return low
	case v < 67:
		return mid
	default:
		return high
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/backend && go test ./internal/chat/... -v`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `cd packages/backend && gofmt -l ./internal/ && go build ./... && go vet ./... && go test ./...`

```bash
git add packages/backend/internal/chat/composer.go packages/backend/internal/chat/composer_test.go
git commit -m "feat(chat): add the pure prompt composer"
```

---

## What Plan C deliberately leaves out

- **No LLM call, no provider, no API key.** `Compose` returns segments; turning them into a vendor payload is Plan D.
- **No `chat_messages` reads or writes.** `History` is passed in as plain `[]Turn`; persistence is Plan D.
- **No moderation.** `Redact` handles curator-marked `do_not_discuss` rows only; inbound user moderation is Plan D's `Guard`.
- **No wiring into `Session`.** Nothing in Plan C is called by the running server yet.
- **No integration test against Postgres.** This repo has no fixture and none is added; the three `Load*`/`Search*` functions are verified by reading and first exercised in Plan D.

## Carried forward from Plan B

`chat_transcript_segments.start_date` is `timestamptz` while `news_items.start_date` is `timestamp`. Both are forced to `.UTC()` at their scan sites here. Any new query against either must do the same — Go will not raise about a mis-located timestamp, it will just compare wrong.
