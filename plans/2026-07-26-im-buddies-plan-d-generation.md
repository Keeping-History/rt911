# IM Buddies Plan D — Providers, Generator, Guard, Store

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the clock-gated `chat` channel built in Plans A–C into buddies that actually reply — generated through a pluggable provider, moderated on the way in, sanitised on the way out, and logged per user.

**Architecture:** Four new units in the existing `packages/backend/internal/chat/` package — `Provider` (one adapter per vendor family), `Generator` (bounded worker pool, the only blocking I/O), `Guard` (inbound moderation), `Store` (per-user message log) — plus the settings resolver that decides which provider/model a given message uses. The session goroutine only ever *enqueues*; every network call happens on a generator worker. Two design gaps left open by Plan C are closed first, in Task 1, because every later task composes prompts through them.

**Tech Stack:** Go 1.25, pgx/pgxpool, `github.com/anthropics/anthropic-sdk-go`, `github.com/openai/openai-go`, Directus-owned Postgres schema (already applied to api-beta).

## Global Constraints

Copied from `plans/2026-07-24-im-buddies-chatbot-design.md` and `packages/backend/CLAUDE.md`. Every task's requirements implicitly include this section.

- **Never block the Hub.** Tick fan-out stays non-blocking (`select { case ch <- struct{}{}: default: }`).
- **`Session.send_` must never block.** Non-blocking send with a `default:` that logs and drops.
- **Hold `Session.mu` for the shortest possible window.** Lock → mutate → unlock → *then* `send_` or I/O.
- **Chat is a side channel and must never take down media streaming.** Wire into `cmd/server/main.go` as a non-fatal block.
- **All times are UTC `time.Time`.** Never compare formatted strings.
- **Nullable text columns scan into `*string`**, then `derefStr`.
- **No backwards-compat shims.** One consumer, one producer; wire changes update both sides in the same commit.
- **Server→client is binary MessagePack; client→server is JSON text.** Do not flip either direction.
- **`slog` everywhere**, structured keys, loggers passed in. Never import `log`.
- **Credentials never live in Directus.** One key per provider in `rt911-secrets`, read from env.
- **`max_tokens` defaults to 2000.** The cap covers reasoning *and* response text; brevity comes from the prompt and the post-processor, not the cap.
- **Non-streaming.** Replies are short and deliberately delayed behind a typing indicator.
- **Anthropic: never set `thinking: {type: "disabled"}`** — on Opus 5 that can leak `<thinking>` tags into the visible reply. Use `output_config: {effort: "low"}`.
- **Anthropic: check `stop_reason == "refusal"` before reading content.** A decline is HTTP 200 with empty or partial content.
- **Anthropic: no `temperature`** — Opus 5 returns 400. The Anthropic adapter drops it.
- **Output is text and text emoticons only.** No markdown, no Unicode emoji, no URLs, no non-ASCII. Prompted *and* mechanically enforced.
- **Go tests live next to the code** (`foo_test.go`). No `tests/` directory.
- **Run before every commit:** `cd packages/backend && go build ./... && go vet ./... && go test ./...`

### Schema is already live — do not re-apply it

All nine collections exist on api-beta, including every column this plan needs. Verified 2026-07-26:

- `chat_settings`: `provider`, `model`, `max_tokens` (all NOT NULL), `effort`, `temperature`, `openai_base_url` (nullable). **Zero rows** — the singleton is absent, and the loader must treat that as "use shipped defaults", not as an error.
- `chat_profiles`: already carries `provider`, `model`, `max_tokens`, `effort`, `temperature`, `system_prompt_extra`, `typing_speed`.
- Row counts: `chat_profiles` 2, `chat_phases` 10, `chat_beacons` 6, `chat_knowledge` **0**, `chat_schedules` **0**.
- `chat_transcript_segments` is populated: **223,890 TV** rows across 23 channels, **3,821 radio** rows (WINS + WCBS only).

`chat_knowledge` being empty is expected and must degrade gracefully: with no tier-1 rows a buddy has only broadcast and timeline passages. Do not add a "knowledge required" error path.

---

## File Structure

| File | Responsibility |
|---|---|
| `internal/chat/composer.go` *(modify)* | Add the `Timeline` slot and medium-aware broadcast rendering |
| `internal/chat/knowledge.go` *(modify)* | Carry `Medium` on `Passage`; select it in `LoadBroadcast` |
| `internal/chat/beacon.go` *(modify)* | Export `DefaultPhase`; return it from `PhaseAt` on no-match |
| `internal/chat/settings.go` *(create)* | `Settings`, `ShippedDefaults`, `LoadSettings`, `Merge` |
| `internal/chat/profile.go` *(modify)* | Load the five per-profile overrides + `SystemPromptExtra`, `TypingSpeed` |
| `internal/chat/sanitize.go` *(create)* | Deterministic output post-processor + anachronism blocklist |
| `internal/chat/provider.go` *(create)* | `Provider` interface, `Request`, `Reply`, `Outcome` |
| `internal/chat/provider_anthropic.go` *(create)* | Anthropic adapter |
| `internal/chat/provider_openai.go` *(create)* | OpenAI-compatible adapter (OpenAI + OpenRouter) |
| `internal/chat/store.go` *(create)* | `AppendMessage`, `History`, `HasPriorContact` |
| `internal/chat/guard.go` *(create)* | `Check` → allow/block/escalate; block load/write |
| `internal/chat/generator.go` *(create)* | Bounded worker pool; resolve → compose → call → sanitize |
| `internal/session/session.go` *(modify)* | `ChatSend`, `ChatHistory`, typing/stall frames, seek/pause coupling |
| `internal/handler/ws.go` *(modify)* | Parse `chat_send` / `chat_history` |
| `internal/chat/schedule.go` *(create)* | Scheduled beats from `chat_schedules` |
| `cmd/server/main.go` *(modify)* | Construct the generator non-fatally |
| `docs/websocket-protocol.md` *(modify)* | Document the new frames |

---

## Task 1: Close the two Plan C design gaps

Plan C shipped with two known gaps recorded in `plans/2026-07-24-im-buddies-plan-a-carryforward.md`. Both are prompt-correctness bugs and every later task composes through them, so they are closed first.

**Gap 1 — tier 3 has nowhere correct to go.** `Digest` is `StabilityAppendOnly` and carries the "refer to it vaguely" instruction; `Recent` is `StabilityVolatile` and is headed *"What you have just heard on TV"*. Tier 3 is retrieved by per-message full-text search, so it changes every turn. Putting it in `Digest` gives the right instruction but breaks the cache breakpoint the adapter places on the strength of that tag; putting it in `Recent` caches honestly but tells the model that retrospective investigative detail is something the buddy *just watched on television*. Fix: a third slot.

**Gap 1b — `Recent` says "on TV" for radio.** `LoadBroadcast` does not filter or report `medium`, and the corpus now contains 3,821 WINS/WCBS radio segments. Without this, radio is rendered to the model as television.

**Gap 2 — the zero-value `Phase` is self-contradictory.** `Coherence`'s polarity is inverted relative to the other four dials: `Shock: 0` is calm (benign) but `Coherence: 0` renders *"You are struggling to finish a thought"*. `PhaseAt` returns `(Phase{}, false)` when a profile has no phases, so any caller that ignores the bool renders *"You are not especially worried. You are struggling to finish a thought."* Fix by exporting a sane default and returning it, **not** by flipping the dial — `chat_phases` already holds 10 live rows seeded with high-means-composed, and the seed script documents that polarity.

**Files:**
- Modify: `packages/backend/internal/chat/knowledge.go` (`Passage`, `broadcastSelect`, `LoadBroadcast`)
- Modify: `packages/backend/internal/chat/composer.go` (`ComposeInput`, `Compose`, `knowledgeBlock`, new `broadcastBlock`/`timelineBlock`)
- Modify: `packages/backend/internal/chat/beacon.go` (`DefaultPhase`, `PhaseAt`)
- Test: `packages/backend/internal/chat/composer_test.go`, `packages/backend/internal/chat/beacon_test.go`

**Interfaces:**
- Consumes: `Passage`, `Tier`, `Phase`, `PhaseAt`, `ComposeInput`, `Compose`, `Stability` (all existing).
- Produces:
  - `Passage` gains `Medium string` (`"tv"` / `"radio"`; empty for tiers 1 and 3).
  - `ComposeInput` gains `Timeline []Passage`.
  - `var DefaultPhase Phase`.
  - `PhaseAt(phases []Phase, beacons map[int]Beacon, t time.Time) (Phase, bool)` — unchanged signature, now returns `DefaultPhase` instead of `Phase{}` when `ok` is false.

- [ ] **Step 1: Write the failing tests**

Add to `composer_test.go`:

```go
func TestComposeRendersTimelineSeparatelyFromBroadcast(t *testing.T) {
	segs := Compose(ComposeInput{
		Profile:  Profile{ScreenName: "danny", Persona: "p"},
		Phase:    DefaultPhase,
		Recent:   []Passage{{Tier: TierBroadcast, Medium: "tv", Text: "we are getting reports"}},
		Timeline: []Passage{{Tier: TierTimeline, Text: "investigators later concluded"}},
	})

	var broadcast, timeline string
	for _, s := range segs {
		if strings.Contains(s.Text, "we are getting reports") {
			broadcast = s.Text
		}
		if strings.Contains(s.Text, "investigators later concluded") {
			timeline = s.Text
		}
	}
	if broadcast == "" || timeline == "" {
		t.Fatalf("both passages must render; got broadcast=%q timeline=%q", broadcast, timeline)
	}
	if broadcast == timeline {
		t.Fatal("tier 2 and tier 3 must not share a segment")
	}
	// The misattribution this slot exists to prevent.
	if strings.Contains(timeline, "just heard") {
		t.Errorf("tier 3 rendered as something the buddy just heard: %q", timeline)
	}
	if !strings.Contains(timeline, "do not quote") {
		t.Errorf("tier 3 lost its paraphrase instruction: %q", timeline)
	}
}

func TestComposeLabelsRadioAsRadioNotTV(t *testing.T) {
	segs := Compose(ComposeInput{
		Profile: Profile{ScreenName: "danny", Persona: "p"},
		Phase:   DefaultPhase,
		Recent: []Passage{
			{Tier: TierBroadcast, Medium: "radio", Text: "ten-ten wins news time"},
		},
	})

	for _, s := range segs {
		if strings.Contains(s.Text, "ten-ten wins news time") {
			if strings.Contains(s.Text, "on TV") {
				t.Errorf("radio segment described as television: %q", s.Text)
			}
			if !strings.Contains(s.Text, "radio") {
				t.Errorf("radio segment not identified as radio: %q", s.Text)
			}
			return
		}
	}
	t.Fatal("radio passage did not render at all")
}

func TestComposeStabilityIsMonotonic(t *testing.T) {
	segs := Compose(ComposeInput{
		Profile:  Profile{ScreenName: "danny", Persona: "p"},
		Phase:    DefaultPhase,
		Digest:   []Passage{{Tier: TierCurated, Text: "a plane hit the north tower"}},
		Recent:   []Passage{{Tier: TierBroadcast, Medium: "tv", Text: "b"}},
		Timeline: []Passage{{Tier: TierTimeline, Text: "c"}},
		History:  []Turn{{FromBuddy: false, Text: "hi"}},
	})

	// Prefix caching depends on this: a volatile segment before a stable one
	// invalidates everything after it on every turn.
	for i := 1; i < len(segs); i++ {
		if segs[i].Stability < segs[i-1].Stability {
			t.Fatalf("segment %d (%d) is more stable than %d (%d)",
				i, segs[i].Stability, i-1, segs[i-1].Stability)
		}
	}
}
```

Add to `beacon_test.go`:

```go
func TestDefaultPhaseIsInternallyConsistent(t *testing.T) {
	d := dialDirective(DefaultPhase)
	if strings.Contains(d, "struggling to finish a thought") {
		t.Errorf("DefaultPhase renders as incoherent: %q", d)
	}
	if !strings.Contains(d, "not especially worried") {
		t.Errorf("DefaultPhase should be calm: %q", d)
	}
}

func TestPhaseAtFallsBackToDefaultPhaseNotZeroValue(t *testing.T) {
	got, ok := PhaseAt(nil, beaconSet(), at("14:00"))
	if ok {
		t.Fatal("no phases configured must report ok=false")
	}
	if got != DefaultPhase {
		t.Errorf("no-match must yield DefaultPhase, got %+v", got)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/backend && go test ./internal/chat/ -run 'Timeline|Radio|Monotonic|DefaultPhase' -v`
Expected: compile failure — `Medium`, `Timeline`, and `DefaultPhase` are undefined.

- [ ] **Step 3: Add `Medium` to `Passage` and select it**

In `knowledge.go`, add the field to `Passage`:

```go
	Medium      string // "tv" or "radio" for tier 2; empty otherwise
```

Change `broadcastSelect` to `SELECT start_date, text, medium` and scan it in `LoadBroadcast`:

```go
	var medium *string
	if err := rows.Scan(&at, &text, &medium); err != nil {
		return nil, err
	}
	out = append(out, Passage{
		Tier:   TierBroadcast,
		At:     at,
		Text:   text,
		Medium: derefStr(medium),
	})
```

- [ ] **Step 4: Add the `Timeline` slot and medium-aware rendering**

In `composer.go`, add `Timeline []Passage` to `ComposeInput` after `Recent`. Replace the `Recent` block in `Compose` and append the timeline block, keeping the stability order 0 → 1 → 1 → 2 → 2 → 2:

```go
	if len(in.Recent) > 0 {
		segs = append(segs, PromptSegment{
			Stability: StabilityVolatile,
			Role:      "user",
			Text:      broadcastBlock(in.Recent),
		})
	}
	if len(in.Timeline) > 0 {
		segs = append(segs, PromptSegment{
			Stability: StabilityVolatile,
			Role:      "user",
			Text:      timelineBlock(in.Timeline),
		})
	}
```

Add the two renderers. `broadcastBlock` groups by medium so radio is never described as television — deterministic order, TV first:

```go
func broadcastBlock(passages []Passage) string {
	var tv, radio []Passage
	for _, p := range passages {
		if p.Medium == "radio" {
			radio = append(radio, p)
			continue
		}
		tv = append(tv, p)
	}

	var b strings.Builder
	if len(tv) > 0 {
		b.WriteString("What you have just heard on TV:\n")
		b.WriteString(passageLines(tv))
	}
	if len(radio) > 0 {
		if b.Len() > 0 {
			b.WriteString("\n")
		}
		b.WriteString("What you have just heard on the radio:\n")
		b.WriteString(passageLines(radio))
	}
	return b.String()
}

// timelineBlock renders tier 3. It is deliberately not headed as something the
// buddy saw or heard: these passages are retrospective reporting, and a buddy
// on the day could not have had them. The instruction is what keeps the model
// from stating them as first-hand knowledge.
func timelineBlock(passages []Passage) string {
	var b strings.Builder
	b.WriteString("Background you are only half-aware of:\n")
	b.WriteString(passageLines(passages))
	b.WriteString("\nYou are not sure of these details. Refer to them vaguely if at " +
		"all, and do not quote them.\n")
	return b.String()
}
```

Delete the tier-3 scan from `knowledgeBlock` — tier 3 no longer reaches `Digest`, so the loop is dead code that would double the instruction if a caller mixed tiers:

```go
func knowledgeBlock(passages []Passage) string {
	var b strings.Builder
	b.WriteString("What you know so far:\n")
	b.WriteString(passageLines(passages))
	return b.String()
}
```

- [ ] **Step 5: Export `DefaultPhase` and return it from `PhaseAt`**

In `beacon.go`, above `PhaseAt`:

```go
// DefaultPhase is the phase a profile falls back to when it has none configured
// or when virtual time precedes its first beacon.
//
// It exists because Phase's zero value is not neutral: Coherence's polarity is
// inverted relative to the other four dials, so Phase{} renders the
// self-contradictory "You are not especially worried. You are struggling to
// finish a thought." The polarity itself is not flipped because chat_phases
// already holds live rows seeded with high-means-composed.
var DefaultPhase = Phase{
	Shock:      0,
	Coherence:  100,
	Verbosity:  50,
	TypoRate:   20,
	TopicFocus: 0,
}
```

In `PhaseAt`, change the declaration and the not-found return so the zero value never escapes:

```go
	best := DefaultPhase
```

and ensure the function returns `(best, found)` — with `best` initialised to `DefaultPhase`, the `found == false` path now yields the default rather than `Phase{}`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/backend && go test ./internal/chat/ -v`
Expected: PASS, including the pre-existing `TestPhaseAtWithNoPhasesReturnsFalse` (it asserts only `ok`, so the new fallback does not break it).

- [ ] **Step 7: Commit**

```bash
cd /home/robbiebyrd/rt911
git add packages/backend/internal/chat/composer.go packages/backend/internal/chat/composer_test.go \
        packages/backend/internal/chat/knowledge.go packages/backend/internal/chat/beacon.go \
        packages/backend/internal/chat/beacon_test.go
git commit -m "fix(chat): give tier 3 its own slot and stop calling radio television"
```

---

## Task 2: Settings resolution

Resolve provider/model/limits per message as **profile override → global default → shipped default**. `chat_settings` has zero rows, so absence is a normal state, not an error.

**Files:**
- Create: `packages/backend/internal/chat/settings.go`
- Modify: `packages/backend/internal/chat/profile.go` (`Profile`, `profileSelect`, `LoadProfiles`)
- Test: `packages/backend/internal/chat/settings_test.go`

**Interfaces:**
- Consumes: `Profile`, `derefStr`.
- Produces:
  - `type Settings struct { Provider, Model string; MaxTokens int; Effort string; Temperature *float64; OpenAIBaseURL string }`
  - `var ShippedDefaults Settings`
  - `func LoadSettings(ctx context.Context, pool *pgxpool.Pool) (Settings, error)`
  - `func (s Settings) Merge(p Profile) Settings`
  - `Profile` gains `Provider, Model, Effort *string`, `MaxTokens *int`, `Temperature *float64`, `SystemPromptExtra string`, `TypingSpeed int`.

- [ ] **Step 1: Write the failing test**

```go
func TestShippedDefaultsMatchTheSpec(t *testing.T) {
	if ShippedDefaults.Provider != "anthropic" || ShippedDefaults.Model != "claude-opus-5" {
		t.Errorf("provider/model drifted: %+v", ShippedDefaults)
	}
	if ShippedDefaults.MaxTokens != 2000 {
		t.Errorf("max_tokens must be 2000, got %d", ShippedDefaults.MaxTokens)
	}
	if ShippedDefaults.Effort != "low" {
		t.Errorf("effort must be low, got %q", ShippedDefaults.Effort)
	}
	if ShippedDefaults.Temperature != nil {
		t.Errorf("temperature must default to unset, got %v", *ShippedDefaults.Temperature)
	}
}

func TestMergePrefersProfileOverGlobal(t *testing.T) {
	global := Settings{Provider: "anthropic", Model: "claude-opus-5", MaxTokens: 2000, Effort: "low"}
	model := "claude-haiku-4-5-20251001"
	tokens := 500

	got := global.Merge(Profile{Model: &model, MaxTokens: &tokens})

	if got.Model != model {
		t.Errorf("profile model ignored: %q", got.Model)
	}
	if got.MaxTokens != 500 {
		t.Errorf("profile max_tokens ignored: %d", got.MaxTokens)
	}
	if got.Provider != "anthropic" {
		t.Errorf("unset override must inherit, got %q", got.Provider)
	}
}

func TestMergeTreatsNilAsInheritNotAsZero(t *testing.T) {
	global := Settings{Provider: "openai", Model: "gpt-5", MaxTokens: 2000}

	got := global.Merge(Profile{})

	if got != global {
		t.Errorf("a profile with no overrides must be a no-op, got %+v", got)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/backend && go test ./internal/chat/ -run Settings -v`
Expected: compile failure — `Settings` undefined.

- [ ] **Step 3: Write the implementation**

```go
// ShippedDefaults is the configuration used when chat_settings has no row.
//
// The singleton is genuinely absent on a fresh install, so this is a normal
// path rather than a failure: a missing settings row must not stop every buddy
// from replying.
var ShippedDefaults = Settings{
	Provider:  "anthropic",
	Model:     "claude-opus-5",
	MaxTokens: 2000,
	Effort:    "low",
}

const settingsSelect = `
	SELECT provider, model, max_tokens, effort, temperature, openai_base_url
	FROM chat_settings
	ORDER BY id
	LIMIT 1`

func LoadSettings(ctx context.Context, pool *pgxpool.Pool) (Settings, error) {
	var s Settings
	var effort, baseURL *string
	var temp *float64

	err := pool.QueryRow(ctx, settingsSelect).
		Scan(&s.Provider, &s.Model, &s.MaxTokens, &effort, &temp, &baseURL)
	if errors.Is(err, pgx.ErrNoRows) {
		return ShippedDefaults, nil
	}
	if err != nil {
		return ShippedDefaults, fmt.Errorf("load chat settings: %w", err)
	}

	s.Effort = derefStr(effort)
	s.OpenAIBaseURL = derefStr(baseURL)
	s.Temperature = temp
	return s, nil
}

// Merge applies a profile's per-field overrides. A nil override means inherit —
// it must never be read as a zero value, or a profile that sets nothing would
// silently request max_tokens 0.
func (s Settings) Merge(p Profile) Settings {
	if p.Provider != nil {
		s.Provider = *p.Provider
	}
	if p.Model != nil {
		s.Model = *p.Model
	}
	if p.MaxTokens != nil {
		s.MaxTokens = *p.MaxTokens
	}
	if p.Effort != nil {
		s.Effort = *p.Effort
	}
	if p.Temperature != nil {
		s.Temperature = p.Temperature
	}
	return s
}
```

In `profile.go`, extend `profileSelect` with `provider, model, max_tokens, effort, temperature, system_prompt_extra, typing_speed`, add the fields to `Profile`, and scan them as pointers (keeping nil as "inherit").

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/backend && go test ./internal/chat/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/internal/chat/settings.go packages/backend/internal/chat/settings_test.go \
        packages/backend/internal/chat/profile.go
git commit -m "feat(chat): resolve provider settings per profile with shipped defaults"
```

---

## Task 3: Output post-processor

The requirement is *text and text emoticons only, no special characters, formatting, or colors*. A prompt asks; this guarantees. Pure and exhaustively table-testable — no network.

**Files:**
- Create: `packages/backend/internal/chat/sanitize.go`
- Test: `packages/backend/internal/chat/sanitize_test.go`

**Interfaces:**
- Produces:
  - `func Sanitize(s string, maxRunes int) string`
  - `var Anachronisms []string`
  - `func HasAnachronism(s string) (string, bool)`

- [ ] **Step 1: Write the failing test**

```go
func TestSanitizeStripsEverythingButPlainText(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"markdown bold", "that is **really** bad", "that is really bad"},
		{"markdown italic", "that is _really_ bad", "that is really bad"},
		{"backticks", "type `brb` ok", "type brb ok"},
		{"unicode emoji", "omg 😱 scary", "omg scary"},
		{"smart quotes", "he said \u201chi\u201d", `he said "hi"`},
		{"em dash", "wait \u2014 what", "wait - what"},
		{"url", "see http://cnn.com now", "see now"},
		{"collapse whitespace", "omg    what\n\n\nis   that", "omg what is that"},
		{"keeps emoticon", "im scared :-(", "im scared :-("},
		{"keeps apostrophe", "i dont know", "i dont know"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Sanitize(c.in, 500); got != c.want {
				t.Errorf("Sanitize(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

func TestSanitizeCapsLengthOnAWordBoundary(t *testing.T) {
	got := Sanitize("aaaa bbbb cccc dddd", 10)
	if len([]rune(got)) > 10 {
		t.Errorf("exceeded cap: %q", got)
	}
	if strings.HasSuffix(got, " ") {
		t.Errorf("trailing space after truncation: %q", got)
	}
}

func TestSanitizeIsIdempotent(t *testing.T) {
	in := "**omg** 😱 see http://x.com \u2014 now"
	once := Sanitize(in, 500)
	if twice := Sanitize(once, 500); once != twice {
		t.Errorf("not idempotent: %q then %q", once, twice)
	}
}

func TestHasAnachronismCatchesPostEraSlang(t *testing.T) {
	for _, bad := range []string{"smh", "fr fr", "ngl that was wild", "bruh"} {
		if _, found := HasAnachronism(bad); !found {
			t.Errorf("missed anachronism in %q", bad)
		}
	}
	// Must match whole words only: "brb" is era-correct and contains no anachronism,
	// and "ngl" must not fire inside "angle".
	for _, ok := range []string{"brb", "g2g", "what is the angle on that", "sup"} {
		if term, found := HasAnachronism(ok); found {
			t.Errorf("false positive %q in %q", term, ok)
		}
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/backend && go test ./internal/chat/ -run 'Sanitize|Anachronism' -v`
Expected: compile failure — `Sanitize` undefined.

- [ ] **Step 3: Write the implementation**

```go
var (
	reURL       = regexp.MustCompile(`https?://\S+|www\.\S+`)
	reMarkdown  = regexp.MustCompile("[*_`~#>]+")
	reWhitespace = regexp.MustCompile(`\s+`)
	reWordChars = regexp.MustCompile(`[a-z0-9]+`)
)

// replacements maps era-incorrect typography to its ASCII equivalent. A 2001 AIM
// client could not render any of these, so they are as wrong as an emoji.
var replacements = strings.NewReplacer(
	"\u201c", `"`, "\u201d", `"`,
	"\u2018", "'", "\u2019", "'",
	"\u2014", "-", "\u2013", "-",
	"\u2026", "...",
)

// Anachronisms are terms that postdate 2001 and instantly break the illusion.
var Anachronisms = []string{
	"smh", "fr", "ngl", "bruh", "lowkey", "highkey", "sus", "yeet",
	"cringe", "based", "vibe", "vibes", "salty", "ghosted", "selfie",
	"google", "googled", "texting", "texted", "wifi", "app", "apps",
	"smartphone", "iphone", "youtube", "facebook", "twitter", "tweet",
}

// Sanitize reduces a generated reply to what a 2001 IM client could display:
// plain ASCII text and text emoticons. Everything else is removed rather than
// escaped -- a buddy typing a literal asterisk is a bug, not a style choice.
func Sanitize(s string, maxRunes int) string {
	s = replacements.Replace(s)
	s = reURL.ReplaceAllString(s, "")
	s = reMarkdown.ReplaceAllString(s, "")

	// Drop anything still non-ASCII: emoji, accented characters, box drawing.
	var b strings.Builder
	for _, r := range s {
		if r < 128 {
			b.WriteRune(r)
		}
	}
	s = reWhitespace.ReplaceAllString(b.String(), " ")
	s = strings.TrimSpace(s)

	return truncateRunes(s, maxRunes)
}

// truncateRunes cuts at the last space before the cap so a reply never ends
// mid-word, which reads as a crash rather than as brevity.
func truncateRunes(s string, maxRunes int) string {
	r := []rune(s)
	if maxRunes <= 0 || len(r) <= maxRunes {
		return s
	}
	cut := string(r[:maxRunes])
	if i := strings.LastIndex(cut, " "); i > 0 {
		cut = cut[:i]
	}
	return strings.TrimSpace(cut)
}

// HasAnachronism reports the first post-2001 term found, matching whole words
// only so "ngl" does not fire inside "angle".
func HasAnachronism(s string) (string, bool) {
	words := reWordChars.FindAllString(strings.ToLower(s), -1)
	seen := make(map[string]bool, len(words))
	for _, w := range words {
		seen[w] = true
	}
	for _, a := range Anachronisms {
		if seen[a] {
			return a, true
		}
	}
	return "", false
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/backend && go test ./internal/chat/ -run 'Sanitize|Anachronism' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/internal/chat/sanitize.go packages/backend/internal/chat/sanitize_test.go
git commit -m "feat(chat): add the deterministic output post-processor"
```

---

## Task 4: Provider interface and Anthropic adapter

**Files:**
- Create: `packages/backend/internal/chat/provider.go`, `packages/backend/internal/chat/provider_anthropic.go`
- Test: `packages/backend/internal/chat/provider_test.go`
- Modify: `packages/backend/go.mod`

**Interfaces:**
- Consumes: `PromptSegment`, `Stability`, `Settings`.
- Produces:
  - `type Outcome string` with `OutcomeOK`, `OutcomeRefused`, `OutcomeTruncated`, `OutcomeError`
  - `type Request struct { Segments []PromptSegment; Model string; MaxTokens int; Effort string; Temperature *float64 }`
  - `type Reply struct { Body string; Outcome Outcome; TokensIn, TokensOut, CachedIn int; Model string }`
  - `type Provider interface { Name() string; Generate(ctx context.Context, r Request) (Reply, error) }`
  - `func NewAnthropicProvider(apiKey string, logger *slog.Logger) Provider`
  - `func cacheBreakpoints(segs []PromptSegment) []int` — indices of the last segment in each stability class, capped at four.

> **SDK surface must be confirmed before writing.** `anthropic-sdk-go`'s exact type names change between releases. Resolve the current API with Context7 (`resolve-library-id` → `anthropics/anthropic-sdk-go`, then `query-docs` for "messages with cache_control and beta fallbacks") before implementing `Generate`. The behavioural contract below is fixed regardless of SDK shape.

- [ ] **Step 1: Write the failing test**

`cacheBreakpoints` is the part worth testing without a network call — Anthropic allows at most four `cache_control` markers per request, and the whole prompt layout is designed around placing them at stability boundaries.

```go
func TestCacheBreakpointsSitAtStabilityBoundaries(t *testing.T) {
	segs := []PromptSegment{
		{Stability: StabilityStable},     // 0 persona
		{Stability: StabilityAppendOnly}, // 1 digest
		{Stability: StabilityAppendOnly}, // 2 history  <- last append-only
		{Stability: StabilityVolatile},   // 3 broadcast
		{Stability: StabilityVolatile},   // 4 live turn
	}

	got := cacheBreakpoints(segs)

	// Mark the end of each cacheable run; never mark a volatile segment, which
	// changes every turn and would pay the write premium for a guaranteed miss.
	want := []int{0, 2}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("cacheBreakpoints = %v, want %v", got, want)
	}
}

func TestCacheBreakpointsNeverExceedFour(t *testing.T) {
	var segs []PromptSegment
	for i := 0; i < 12; i++ {
		segs = append(segs, PromptSegment{Stability: Stability(i % 2)})
	}
	if got := cacheBreakpoints(segs); len(got) > 4 {
		t.Errorf("returned %d breakpoints, Anthropic permits 4", len(got))
	}
}

func TestOutcomeConstantsAreStable(t *testing.T) {
	// These strings are written to chat_messages.moderation and read by the
	// dev harness, so renaming one is a data migration, not a refactor.
	if OutcomeOK != "ok" || OutcomeRefused != "refused" ||
		OutcomeTruncated != "truncated" || OutcomeError != "error" {
		t.Error("outcome constants drifted from the wire contract")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/backend && go test ./internal/chat/ -run 'CacheBreakpoints|Outcome' -v`
Expected: compile failure — `cacheBreakpoints` undefined.

- [ ] **Step 3: Add the SDK and write `provider.go`**

```bash
cd packages/backend && go get github.com/anthropics/anthropic-sdk-go@latest
```

```go
type Outcome string

const (
	OutcomeOK        Outcome = "ok"
	OutcomeRefused   Outcome = "refused"
	OutcomeTruncated Outcome = "truncated"
	OutcomeError     Outcome = "error"
)

type Request struct {
	Segments    []PromptSegment
	Model       string
	MaxTokens   int
	Effort      string
	Temperature *float64
}

type Reply struct {
	Body      string
	Outcome   Outcome
	TokensIn  int
	TokensOut int
	CachedIn  int
	Model     string
}

type Provider interface {
	Name() string
	Generate(ctx context.Context, r Request) (Reply, error)
}

// cacheBreakpoints returns the indices that should carry a cache_control marker:
// the last segment of each non-volatile stability run. Anthropic permits four
// per request; volatile segments are never marked because they differ every turn
// and would pay the 1.25x write premium for a guaranteed miss.
func cacheBreakpoints(segs []PromptSegment) []int {
	var out []int
	for i, s := range segs {
		if s.Stability == StabilityVolatile {
			continue
		}
		if i+1 == len(segs) || segs[i+1].Stability != s.Stability {
			out = append(out, i)
		}
	}
	if len(out) > 4 {
		out = out[len(out)-4:]
	}
	return out
}
```

- [ ] **Step 4: Write `provider_anthropic.go`**

Behavioural contract, all of it load-bearing:

- Render `PromptSegment` with `Role == "system"` into the `System` field; everything else into `Messages` in order.
- Place `cache_control: {type: "ephemeral"}` at each index from `cacheBreakpoints`.
- Set `output_config: {effort: <Request.Effort>}`. **Never** set `thinking: {type: "disabled"}`.
- **Drop `Temperature` entirely** — Opus 5 returns 400.
- Call through `client.Beta.Messages.New` with `Betas: []string{"server-side-fallback-2026-07-01"}` and `fallbacks: "default"`.
- **Check `stop_reason` before reading content.** `"refusal"` → `Reply{Outcome: OutcomeRefused}` with an empty body and a `nil` error; `"max_tokens"` → `OutcomeTruncated` with whatever text arrived.
- Map usage into `TokensIn`, `TokensOut`, and `CachedIn` (the cache-read input tokens).
- A transport error returns `Reply{Outcome: OutcomeError}` **and** a non-nil error; the caller decides whether to stall in character.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/backend && go build ./... && go test ./internal/chat/ -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/backend/internal/chat/provider.go packages/backend/internal/chat/provider_anthropic.go \
        packages/backend/internal/chat/provider_test.go packages/backend/go.mod packages/backend/go.sum
git commit -m "feat(chat): add the provider interface and Anthropic adapter"
```

---

## Task 5: OpenAI-compatible adapter

One adapter covers OpenAI and OpenRouter — OpenRouter speaks the OpenAI chat-completions API at a different base URL.

**Files:**
- Create: `packages/backend/internal/chat/provider_openai.go`
- Test: `packages/backend/internal/chat/provider_openai_test.go`

**Interfaces:**
- Consumes: `Provider`, `Request`, `Reply`, `Outcome`, `PromptSegment`.
- Produces: `func NewOpenAICompatProvider(apiKey, baseURL, name string, logger *slog.Logger) Provider`

> Confirm the `openai-go` surface with Context7 before implementing.

- [ ] **Step 1: Write the failing test**

```go
func TestOpenAIProviderReportsItsConfiguredName(t *testing.T) {
	// One adapter serves two vendors; the name is what lands in chat_messages
	// and in the logs, so it must reflect the configured vendor rather than
	// the adapter's implementation.
	p := NewOpenAICompatProvider("k", "https://openrouter.ai/api/v1", "openrouter", slog.Default())
	if p.Name() != "openrouter" {
		t.Errorf("Name() = %q, want openrouter", p.Name())
	}
}

func TestSegmentsRenderInOrderWithSystemFirst(t *testing.T) {
	msgs := openAIMessages([]PromptSegment{
		{Stability: StabilityStable, Role: "system", Text: "you are danny"},
		{Stability: StabilityAppendOnly, Role: "user", Text: "what you know"},
		{Stability: StabilityVolatile, Role: "user", Text: "it is 8:47"},
	})

	if len(msgs) != 3 {
		t.Fatalf("got %d messages, want 3", len(msgs))
	}
	// Prefix caching on OpenAI-compatible endpoints is automatic and depends
	// entirely on this order being preserved.
	if msgs[0].Role != "system" || msgs[2].Content != "it is 8:47" {
		t.Errorf("segment order not preserved: %+v", msgs)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/backend && go test ./internal/chat/ -run OpenAI -v`
Expected: compile failure — `NewOpenAICompatProvider` undefined.

- [ ] **Step 3: Write the implementation**

```bash
cd packages/backend && go get github.com/openai/openai-go@latest
```

Contract:
- `option.WithBaseURL(baseURL)` when `baseURL != ""`; otherwise the SDK default (OpenAI).
- `Name()` returns the configured name (`"openai"` or `"openrouter"`), not a hardcoded string.
- Segments render in order via an `openAIMessages` helper, `system` first.
- **`Temperature` is applied here** — this is the asymmetry with Anthropic, and it is deliberate: on these providers it is a second per-message variance lever.
- `Effort` maps to `reasoning_effort` on reasoning models and is dropped elsewhere.
- `finish_reason: "content_filter"` → `OutcomeRefused`; `"length"` → `OutcomeTruncated`.
- No explicit cache markers — these endpoints cache prefixes automatically above ~1024 tokens.
- Populate `CachedIn` from the usage block's cached-token field when present; leave it zero when the vendor does not report one (OpenRouter's support varies by upstream model and is best-effort).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/backend && go build ./... && go test ./internal/chat/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/internal/chat/provider_openai.go packages/backend/internal/chat/provider_openai_test.go \
        packages/backend/go.mod packages/backend/go.sum
git commit -m "feat(chat): add the OpenAI-compatible adapter for OpenAI and OpenRouter"
```

---

## Task 6: Store

Per-user message log. Two timestamps because there are two timelines: `virtual_time` rebuilds context after a seek, `created_at` supports rate limiting and abuse review. Neither derives from the other.

**Files:**
- Create: `packages/backend/internal/chat/store.go`
- Test: `packages/backend/internal/chat/store_test.go`

**Interfaces:**
- Consumes: `Turn`.
- Produces:
  - `type Message struct { ID int; Profile int; Direction, Body string; VirtualTime time.Time; Kind, Model string; TokensIn, TokensOut int; Moderation map[string]any }`
  - `func AppendMessage(ctx context.Context, pool *pgxpool.Pool, userID string, m Message) (int, error)`
  - `func History(ctx context.Context, pool *pgxpool.Pool, userID string, profileID int, before time.Time, limit int) ([]Turn, error)`
  - `func HasPriorContact(ctx context.Context, pool *pgxpool.Pool, userID string, profileID int, before time.Time) (bool, error)`

- [ ] **Step 1: Write the failing test**

`History` ordering is the part that silently corrupts a conversation, so it is tested without a database by asserting on the SQL contract the loader depends on.

```go
func TestHistorySQLFiltersByVirtualTimeAndUser(t *testing.T) {
	// Seeking backward must not leave a buddy remembering a conversation that
	// has not happened yet, and one user must never read another's log.
	for _, want := range []string{
		`"user" = $1`,
		"profile = $2",
		"virtual_time <= $3",
		"ORDER BY virtual_time",
	} {
		if !strings.Contains(historySelect, want) {
			t.Errorf("historySelect missing %q:\n%s", want, historySelect)
		}
	}
}

func TestTurnsAreReturnedOldestFirst(t *testing.T) {
	// The prompt reads top-to-bottom as a conversation; reversed history makes
	// the buddy answer the wrong question.
	if strings.Contains(historySelect, "virtual_time DESC") &&
		!strings.Contains(historySelect, "reverse") {
		t.Error("history must reach the composer oldest-first")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/backend && go test ./internal/chat/ -run 'History|Turns' -v`
Expected: compile failure — `historySelect` undefined.

- [ ] **Step 3: Write the implementation**

```go
const historySelect = `
	SELECT direction, body
	FROM chat_messages
	WHERE "user" = $1 AND profile = $2 AND virtual_time <= $3
	ORDER BY virtual_time, id
	LIMIT $4`
```

`user` is quoted because it is a reserved word in Postgres. `AppendMessage` inserts `("user", profile, direction, body, virtual_time, created_at, kind, moderation, model, tokens_in, tokens_out)` and returns the new id via `RETURNING id`. `History` maps `direction == "out"` to `Turn{FromBuddy: true}`. `HasPriorContact` is a `SELECT EXISTS` over the same filter — it backs `chat_schedules.requires_prior_contact` in Task 10.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/backend && go test ./internal/chat/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/internal/chat/store.go packages/backend/internal/chat/store_test.go
git commit -m "feat(chat): add the per-user message store"
```

---

## Task 7: Guard

Three outcomes, not two. This is a classroom product about a mass-casualty event: a student writing something raw about the hijackers is processing, not attacking, and a student signalling genuine distress needs a response rather than a block. Collapsing `escalate` into `block` would be the wrong behaviour.

**Files:**
- Create: `packages/backend/internal/chat/guard.go`
- Test: `packages/backend/internal/chat/guard_test.go`

**Interfaces:**
- Produces:
  - `type Decision struct { Outcome, Reason, Evidence string }` — `Outcome` ∈ `allow` / `block` / `escalate`
  - `type Block struct { Scope string; Profile *int; Reason string; Expires *time.Time }`
  - `func CheckLocal(body string, now time.Time, recent []time.Time) Decision`
  - `func LoadBlocks(ctx context.Context, pool *pgxpool.Pool, userID string, now time.Time) ([]Block, error)`
  - `func BlocksApply(blocks []Block, profileID int) (bool, string)`

- [ ] **Step 1: Write the failing test**

```go
func TestDistressEscalatesRatherThanBlocks(t *testing.T) {
	// The distinction this whole unit exists for. A student in distress needs
	// a response; blocking them is the worst available outcome.
	for _, in := range []string{
		"i cant stop crying",
		"this is making me want to hurt myself",
		"i feel like i am going to be sick",
	} {
		got := CheckLocal(in, time.Now(), nil)
		if got.Outcome != "escalate" {
			t.Errorf("CheckLocal(%q).Outcome = %q, want escalate", in, got.Outcome)
		}
	}
}

func TestRawButOnTopicInputIsAllowed(t *testing.T) {
	// Processing, not attacking. These must reach the buddy.
	for _, in := range []string{
		"i hate the hijackers so much",
		"why did they kill all those people",
		"were they trying to kill everyone",
	} {
		if got := CheckLocal(in, time.Now(), nil); got.Outcome != "allow" {
			t.Errorf("CheckLocal(%q).Outcome = %q, want allow", in, got.Outcome)
		}
	}
}

func TestRateLimitBlocksAFlood(t *testing.T) {
	now := time.Now()
	var recent []time.Time
	for i := 0; i < 20; i++ {
		recent = append(recent, now.Add(-time.Duration(i)*time.Second))
	}
	if got := CheckLocal("hi", now, recent); got.Outcome != "block" {
		t.Errorf("20 messages in 20s must rate-limit, got %q", got.Outcome)
	}
}

func TestOverlongInputIsBlocked(t *testing.T) {
	if got := CheckLocal(strings.Repeat("a", 5000), time.Now(), nil); got.Outcome != "block" {
		t.Errorf("oversized input must block, got %q", got.Outcome)
	}
}

func TestExpiredBlocksDoNotApply(t *testing.T) {
	past := time.Now().Add(-time.Hour)
	blocks := []Block{{Scope: "global", Expires: &past}}
	if applied, _ := BlocksApply(blocks, 1); applied {
		t.Error("an expired block must not still apply")
	}
}

func TestProfileScopedBlockOnlyAffectsThatProfile(t *testing.T) {
	p := 7
	blocks := []Block{{Scope: "profile", Profile: &p}}
	if applied, _ := BlocksApply(blocks, 7); !applied {
		t.Error("profile block must apply to its own profile")
	}
	if applied, _ := BlocksApply(blocks, 8); applied {
		t.Error("profile block must not leak to another profile")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/backend && go test ./internal/chat/ -run 'Distress|Raw|RateLimit|Overlong|Block' -v`
Expected: compile failure — `CheckLocal` undefined.

- [ ] **Step 3: Write the implementation**

Local tier only — no network, zero latency, zero cost. Order matters: length cap, then rate limit, then distress, then abuse. Distress is checked **before** abuse so a message containing both is escalated rather than blocked.

```go
const (
	maxBodyRunes  = 2000
	rateWindow    = 60 * time.Second
	rateMaxInWindow = 15
)

// distressTerms escalate rather than block. This is a classroom product about a
// mass-casualty event: a student signalling distress needs a response, and
// silence is the worst thing the system can do.
var distressTerms = []string{
	"hurt myself", "kill myself", "want to die", "cant stop crying",
	"cant breathe", "panic attack", "going to be sick", "scared to death",
}

func CheckLocal(body string, now time.Time, recent []time.Time) Decision {
	if len([]rune(body)) > maxBodyRunes {
		return Decision{Outcome: "block", Reason: "too_long"}
	}

	var inWindow int
	for _, t := range recent {
		if now.Sub(t) <= rateWindow {
			inWindow++
		}
	}
	if inWindow >= rateMaxInWindow {
		return Decision{Outcome: "block", Reason: "rate_limit"}
	}

	lower := strings.ToLower(body)
	for _, term := range distressTerms {
		if strings.Contains(lower, term) {
			return Decision{Outcome: "escalate", Reason: "distress", Evidence: term}
		}
	}
	for _, term := range abuseTerms {
		if strings.Contains(lower, term) {
			return Decision{Outcome: "block", Reason: "abuse", Evidence: term}
		}
	}
	return Decision{Outcome: "allow"}
}
```

`abuseTerms` is a short slur/harassment list — keep it narrow, because the escalation tier exists precisely so the local list does not have to be comprehensive. `BlocksApply` skips blocks whose `Expires` is non-nil and in the past, treats `scope: "global"` as matching any profile, and `scope: "profile"` as matching only its own.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/backend && go test ./internal/chat/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/internal/chat/guard.go packages/backend/internal/chat/guard_test.go
git commit -m "feat(chat): add inbound moderation with distress escalation"
```

---

## Task 8: Generator

The bounded worker pool — the only place blocking I/O happens.

**Files:**
- Create: `packages/backend/internal/chat/generator.go`
- Test: `packages/backend/internal/chat/generator_test.go`

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces:
  - `type Job struct { UserID string; Profile Profile; Phase Phase; Body, Kind string; VirtualTime time.Time; Digest, Recent, Timeline []Passage; History []Turn; Deliver func(Reply, error) }`
  - `func NewGenerator(pool *pgxpool.Pool, providers map[string]Provider, settings Settings, settingsTTL time.Duration, workers, queue int, logger *slog.Logger) *Generator`
  - `func (g *Generator) Enqueue(j Job) bool` — `false` when the queue is full
  - `func (g *Generator) Close()`
  - `const maxReplyRunes = 600`
  - `var ErrNoProvider = errors.New("chat: no provider configured")`

A `nil` pool is valid and means "never reload" — the seeded `Settings` is used for the generator's lifetime. That keeps every test in this task database-free.

- [ ] **Step 1: Write the failing test**

```go
type fakeProvider struct {
	name  string
	reply Reply
	err   error
	calls int32
}

func (f *fakeProvider) Name() string { return f.name }
func (f *fakeProvider) Generate(ctx context.Context, r Request) (Reply, error) {
	atomic.AddInt32(&f.calls, 1)
	return f.reply, f.err
}

func TestEnqueueReturnsFalseWhenTheQueueIsFull(t *testing.T) {
	// Queue-full must be reported, not blocked on: the caller is the session
	// goroutine, and blocking it violates hard rule #2.
	g := NewGenerator(nil, map[string]Provider{"anthropic": &fakeProvider{}}, ShippedDefaults, 0, 0, 1, slog.Default())
	defer g.Close()

	_ = g.Enqueue(Job{})
	if g.Enqueue(Job{}) {
		t.Error("second enqueue on a full queue must return false")
	}
}

func TestGeneratedReplyIsSanitized(t *testing.T) {
	p := &fakeProvider{reply: Reply{Body: "**omg** 😱 http://cnn.com", Outcome: OutcomeOK}}
	g := NewGenerator(nil, map[string]Provider{"anthropic": p}, ShippedDefaults, 0, 1, 4, slog.Default())
	defer g.Close()

	got := make(chan Reply, 1)
	g.Enqueue(Job{
		Profile: Profile{ScreenName: "danny"},
		Deliver: func(r Reply, err error) { got <- r },
	})

	select {
	case r := <-got:
		if strings.ContainsAny(r.Body, "*") || strings.Contains(r.Body, "http") {
			t.Errorf("unsanitized body reached the caller: %q", r.Body)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no reply delivered")
	}
}

func TestUnknownProviderFailsWithoutCallingAnother(t *testing.T) {
	p := &fakeProvider{name: "anthropic"}
	g := NewGenerator(nil, map[string]Provider{"anthropic": p}, Settings{Provider: "nope", Model: "m", MaxTokens: 10}, 0, 1, 4, slog.Default())
	defer g.Close()

	errc := make(chan error, 1)
	g.Enqueue(Job{Deliver: func(r Reply, err error) { errc <- err }})

	select {
	case err := <-errc:
		if !errors.Is(err, ErrNoProvider) {
			t.Errorf("got %v, want ErrNoProvider", err)
		}
		if atomic.LoadInt32(&p.calls) != 0 {
			t.Error("must not silently fall through to a different provider")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no result delivered")
	}
}

func TestDoNotDiscussPassagesNeverReachTheProvider(t *testing.T) {
	// Redact is advisory -- Compose accepts raw []Passage -- so the generator
	// is the only thing enforcing it. A leak here is a content incident, not
	// a bug, which is why it is asserted on the wire rather than trusted.
	var seen Request
	p := &fakeProvider{reply: Reply{Body: "ok", Outcome: OutcomeOK}}
	p.capture = func(r Request) { seen = r }

	g := NewGenerator(nil, map[string]Provider{"anthropic": p}, ShippedDefaults, 0, 1, 4, slog.Default())
	defer g.Close()

	done := make(chan struct{})
	g.Enqueue(Job{
		Profile: Profile{ScreenName: "danny", Persona: "p"},
		Digest: []Passage{
			{Tier: TierCurated, Text: "safe to say", Sensitivity: "normal"},
			{Tier: TierCurated, Text: "GRAPHIC DETAIL", Sensitivity: "do_not_discuss"},
		},
		Deliver: func(Reply, error) { close(done) },
	})

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("no reply delivered")
	}

	for _, s := range seen.Segments {
		if strings.Contains(s.Text, "GRAPHIC DETAIL") {
			t.Fatalf("do_not_discuss passage reached the provider: %q", s.Text)
		}
	}
	// Guard against the test passing because nothing was sent at all.
	var any bool
	for _, s := range seen.Segments {
		if strings.Contains(s.Text, "safe to say") {
			any = true
		}
	}
	if !any {
		t.Error("redaction dropped the safe passage too")
	}
}
```

`fakeProvider` gains a `capture func(Request)` field, invoked at the top of `Generate` when non-nil.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/backend && go test ./internal/chat/ -run 'Enqueue|Generated|UnknownProvider' -v`
Expected: compile failure — `NewGenerator` undefined.

- [ ] **Step 3: Write the implementation**

```go
func (g *Generator) Enqueue(j Job) bool {
	select {
	case g.jobs <- j:
		return true
	default:
		// Never block: the caller is the session goroutine. A dropped job
		// becomes an in-character stall, which preserves the illusion.
		return false
	}
}
```

Declare the reply cap alongside the pool:

```go
// maxReplyRunes is the hard ceiling on a delivered message. A 2001 AIM window
// held far less than this; the prompt asks for brevity and this is the backstop.
const maxReplyRunes = 600
```

Each worker runs this pipeline, in this order:

```go
func (g *Generator) run(j Job) {
	settings := g.resolve().Merge(j.Profile)

	p, ok := g.providers[settings.Provider]
	if !ok {
		g.logger.Warn("chat: unknown provider", "provider", settings.Provider,
			"profile", j.Profile.ScreenName)
		j.Deliver(Reply{Outcome: OutcomeError}, ErrNoProvider)
		return
	}

	// Redact BEFORE Compose. Redact is advisory -- Compose accepts raw
	// []Passage -- so this is the only thing standing between a
	// sensitivity:"do_not_discuss" row and the model. Every tier goes through
	// it, not just the curated one.
	in := ComposeInput{
		Profile:     j.Profile,
		Phase:       j.Phase,
		Digest:      Redact(j.Digest),
		Recent:      Redact(j.Recent),
		Timeline:    Redact(j.Timeline),
		History:     j.History,
		VirtualTime: j.VirtualTime,
		UserMessage: j.Body,
	}

	reply, err := p.Generate(context.Background(), Request{
		Segments:    Compose(in),
		Model:       settings.Model,
		MaxTokens:   settings.MaxTokens,
		Effort:      settings.Effort,
		Temperature: settings.Temperature,
	})

	// Sanitise inside the worker, not at the call site: no path can deliver
	// raw model output, including the error and refusal paths.
	reply.Body = Sanitize(reply.Body, maxReplyRunes)
	j.Deliver(reply, err)
}
```

**Settings are resolved per job, not captured at construction.** Global defaults live in Directus specifically so cost can be retuned without a redeploy — a value read once at boot would make that impossible. `resolve()` re-reads `chat_settings` behind a short TTL cache:

```go
// resolve returns the current global settings, re-reading chat_settings at most
// once every ttl. A single-row indexed query is negligible beside a multi-second
// provider call, and caching it forever would mean a settings change needed a
// restart -- which is exactly what this feature exists to avoid.
func (g *Generator) resolve() Settings {
	g.mu.Lock()
	defer g.mu.Unlock()

	if time.Since(g.settingsAt) < g.settingsTTL {
		return g.settings
	}
	s, err := LoadSettings(context.Background(), g.pool)
	if err != nil {
		// Keep serving on the last good value; a settings blip must not
		// silence every buddy.
		g.logger.Warn("chat: settings reload failed, using cached", "err", err)
		g.settingsAt = time.Now()
		return g.settings
	}
	g.settings, g.settingsAt = s, time.Now()
	return s
}
```

`NewGenerator` therefore takes a `*pgxpool.Pool` and a `settingsTTL time.Duration` (use 30s), with the passed-in `Settings` seeding the cache so a pool-less unit test still works.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/backend && go test ./internal/chat/ -race -v`
Expected: PASS with no race warnings.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/internal/chat/generator.go packages/backend/internal/chat/generator_test.go
git commit -m "feat(chat): add the bounded generator worker pool"
```

---

## Task 9: Session wiring

**Files:**
- Modify: `packages/backend/internal/session/session.go`, `packages/backend/internal/handler/ws.go`, `packages/backend/cmd/server/main.go`, `packages/backend/docs/websocket-protocol.md`
- Test: `packages/backend/internal/session/session_test.go`

**Interfaces:**
- Consumes: `Generator`, `Job`, `Decision`, `AppendMessage`, `History`, `Available`, `Gate`.
- Produces: `func (s *Session) ChatSend(profileID int, body string)`, `func (s *Session) ChatHistory(profileID int, before time.Time, limit int)`, `outMsg` gains `Body`, `Direction`, `Kind`, `MessageID`.

- [ ] **Step 1: Write the failing test**

Use the helpers that already exist in `session_test.go`: `newTestSession`, `recvType` (drains one frame and returns the decoded `outMsg`), and `drain` (discards setup frames so the test asserts on the frame it triggered). Do **not** add a `drainOne` — `recvType` is that helper.

```go
func TestChatSendIsRejectedWhilePaused(t *testing.T) {
	// The UI disabling its input is UX; the server refusing is the guarantee.
	s := newTestSession(t)
	s.SetUser("user-1")
	s.Subscribe(ChannelChat)
	s.Pause()
	drain(t, s) // subscribe_ack + the chat_state that Pause already emits

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

func TestChatSendEmitsTypingBeforeTheReply(t *testing.T) {
	// The typing indicator is the latency budget, not decoration.
	s := newTestSession(t)
	s.SetUser("user-1")
	s.Subscribe(ChannelChat)
	s.SetTime(time.Date(2001, 9, 11, 12, 50, 0, 0, time.UTC))
	drain(t, s)

	s.ChatSend(1, "hey")

	if msg := recvType(t, s); msg.Type != "chat_typing" {
		t.Errorf("first frame must be chat_typing, got %q", msg.Type)
	}
}
```

> `newTestSession` constructs with a `nil` pool, so `ChatSend` must reach the availability check and emit `chat_state` **before** touching the database. Order the method accordingly: gate first, then guard, then persist. If the pool is nil and the gate passes, skip persistence and still enqueue — that keeps these tests database-free. Confirm the exact clock-setting method name on `Session` (`SetTime` here) before writing; the field is `virtualTime`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/backend && go test ./internal/session/ -run ChatSend -v`
Expected: compile failure — `ChatSend` undefined.

- [ ] **Step 3: Write the implementation**

`ChatSend`: build a `Gate` from the session under `mu`, release, call `Available` — on refusal emit `chat_state` and return. Then guard-check, persist the inbound message, emit `chat_typing`, and `Enqueue`. On `Enqueue` returning false, send the in-character stall (`kind: "stall"`) rather than an error frame. The `Deliver` callback holds `mu` only to read what it needs, then calls `send_`.

Add `chat_send` and `chat_history` cases to the `switch msg.Type` block in `ws.go`, parsing into a dedicated struct as `filterMsg` does.

In `main.go`, construct the providers and generator inside a **non-fatal** block: a missing API key logs at warn and leaves chat unavailable; it must not stop media streaming.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/backend && go build ./... && go vet ./... && go test ./... -race`
Expected: PASS. The pre-existing `ws_test.go` must remain byte-identical — chat frames only reach subscribed sessions, so no existing test needs a new drain.

- [ ] **Step 5: Document the wire changes**

Add `chat_send`, `chat_history`, `chat_typing`, and `chat_message` to `docs/websocket-protocol.md`, matching the tables in the design spec.

- [ ] **Step 6: Commit**

```bash
git add packages/backend/internal/session/ packages/backend/internal/handler/ws.go \
        packages/backend/cmd/server/main.go packages/backend/docs/websocket-protocol.md
git commit -m "feat(chat): wire chat_send and chat_history into the session"
```

---

## Task 10: Scheduled beats

Profiles that message first, at times anchored to beacons. `chat_schedules` has zero rows, so this must be inert until content exists.

**Files:**
- Create: `packages/backend/internal/chat/schedule.go`
- Modify: `packages/backend/internal/session/session.go` (per-buddy horizon in `RunTimePump`)
- Test: `packages/backend/internal/chat/schedule_test.go`

**Interfaces:**
- Produces:
  - `type Schedule struct { ID, ProfileID int; AtBeacon *int; OffsetSeconds int; At *time.Time; Kind, Text, Prompt string; RequiresPriorContact bool }`
  - `func LoadSchedules(ctx context.Context, pool *pgxpool.Pool) ([]Schedule, error)`
  - `func (s Schedule) FireAt(beacons map[int]Beacon) (time.Time, bool)`
  - `func DueBetween(schedules []Schedule, beacons map[int]Beacon, from, to time.Time) []Schedule`

- [ ] **Step 1: Write the failing test**

```go
func TestFireAtResolvesBeaconPlusOffsetOnPublicAt(t *testing.T) {
	// Beats anchor to public_at for the same reason phases do: a buddy cannot
	// react to an event before it was knowable.
	b := map[int]Beacon{1: {ID: 1, At: at("12:46"), PublicAt: at("12:51")}}
	id := 1
	got, ok := Schedule{AtBeacon: &id, OffsetSeconds: 120}.FireAt(b)

	if !ok || !got.Equal(at("12:53")) {
		t.Errorf("FireAt = %v (ok=%v), want 12:53", got, ok)
	}
}

func TestAbsoluteAtOverridesTheBeacon(t *testing.T) {
	b := map[int]Beacon{1: {ID: 1, PublicAt: at("12:51")}}
	id := 1
	abs := at("13:30")
	got, ok := Schedule{AtBeacon: &id, OffsetSeconds: 120, At: &abs}.FireAt(b)

	if !ok || !got.Equal(abs) {
		t.Errorf("absolute At must win, got %v", got)
	}
}

func TestDueBetweenIsHalfOpenSoNoBeatFiresTwice(t *testing.T) {
	b := map[int]Beacon{1: {ID: 1, PublicAt: at("12:51")}}
	id := 1
	s := []Schedule{{ID: 9, AtBeacon: &id}}

	if got := DueBetween(s, b, at("12:50"), at("12:51")); len(got) != 1 {
		t.Errorf("beat at the window end must fire once, got %d", len(got))
	}
	if got := DueBetween(s, b, at("12:51"), at("12:52")); len(got) != 0 {
		t.Errorf("same beat must not fire again in the next window, got %d", len(got))
	}
}

func TestScheduleWithAMissingBeaconDoesNotFire(t *testing.T) {
	id := 99
	if _, ok := (Schedule{AtBeacon: &id}).FireAt(map[int]Beacon{}); ok {
		t.Error("a schedule pointing at a deleted beacon must not fire")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/backend && go test ./internal/chat/ -run 'FireAt|Absolute|DueBetween|MissingBeacon' -v`
Expected: compile failure — `Schedule` undefined.

- [ ] **Step 3: Write the implementation**

`FireAt` returns the absolute `At` when set; otherwise the beacon's `PublicAt` plus `OffsetSeconds`, and `false` when the beacon is missing. `DueBetween` uses a half-open `(from, to]` window so a beat fires exactly once as the horizon advances.

- [ ] **Step 4: Wire the horizon into `RunTimePump`**

Track a per-subscribed-buddy horizon on `Session`, as the `usenet` channel does. On each tick, if the clock has crossed a schedule's fire time, check `RequiresPriorContact` via `HasPriorContact`, then enqueue — static kinds deliver `Text` directly without a provider call; generated kinds go through the generator with `Prompt` as the user message. Beats do not fire while paused (`RunTimePump` already short-circuits) and are not backfilled on resume.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/backend && go test ./... -race`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/backend/internal/chat/schedule.go packages/backend/internal/chat/schedule_test.go \
        packages/backend/internal/session/session.go
git commit -m "feat(chat): fire scheduled beats from chat_schedules"
```

---

## Task 11: Directus permissions and the cross-read probe

`chat_messages` and `chat_blocks` are private conversation records. A misconfigured policy leaks one student's conversation to another. This gets a proof, not a checkbox.

**Files:**
- Create: `packages/backend/apply-chat-permissions.mjs`
- Create: `packages/backend/verify-chat-isolation.mjs`

- [ ] **Step 1: Write the permission script**

Follow `apply-chat-schema.mjs` exactly: dry-run by default, `--apply` to write, Directus REST via `fetch`, no driver dependency. Grant on the Teacher/student policy:

- `chat_messages`: create + read, both filtered `{"user": {"_eq": "$CURRENT_USER"}}`.
- `chat_blocks`: read only, same filter.
- `chat_profiles`, `chat_beacons`, `chat_phases`, `chat_schedules`, `chat_knowledge`: public read.
- `chat_settings`: **no public grant in either direction** — admin only. It holds no credentials, but it is operational configuration with direct cost implications.

- [ ] **Step 2: Check for a running backup before applying**

```sh
kubectl exec -n rt911 <db-pod> -- psql -U directus -d directus \
  -c "select pid, state, left(query,60) from pg_stat_activity where query ilike '%COPY%' or query ilike '%pg_dump%';"
```

A schema/permission op queued behind a running `pg_dump` stalls live reads. The daily backup CronJob runs at 09:20 UTC. If one is running, wait.

- [ ] **Step 3: Apply**

```bash
cd packages/backend && node apply-chat-permissions.mjs          # review the dry run
cd packages/backend && node apply-chat-permissions.mjs --apply
```

- [ ] **Step 4: Prove isolation with two real accounts**

This is the step that cannot be skipped or simulated. `verify-chat-isolation.mjs` must:

1. Log in as account A, insert a `chat_messages` row via REST, record its id.
2. Log in as account B and `GET /items/chat_messages?filter[id][_eq]=<id>`.
3. **Assert B receives zero rows.** A non-empty result is a failure that must exit non-zero.
4. Assert B cannot `PATCH` or `DELETE` that row.
5. Repeat for `chat_blocks`.
6. Clean up the probe rows as A.

```bash
cd packages/backend && node verify-chat-isolation.mjs
```

Expected: every assertion passes and the script exits 0. **If any cross-read succeeds, stop and fix the policy before continuing** — this is the one failure in this plan that is a privacy incident rather than a bug.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/apply-chat-permissions.mjs packages/backend/verify-chat-isolation.mjs
git commit -m "feat(chat): scope message and block access to the owning user"
```

---

## Verification before merge

- [ ] `cd packages/backend && go build ./... && go vet ./... && go test ./... -race` — all green.
- [ ] `ws_test.go` is byte-identical to its pre-plan state (chat frames must not leak to unsubscribed sessions).
- [ ] The dev harness (`CHAT_DEV_UI=1`) completes a full round trip against a real key: type a message, see `chat_typing`, receive a sanitized in-character reply.
- [ ] `Reply.CachedIn` is non-zero on the second consecutive message to the same buddy — proof the cache breakpoints are placed correctly.
- [ ] A reply containing markdown, an emoji, or a URL is impossible: confirm by pointing a profile at a prompt that requests one.
- [ ] Pause the clock; confirm `chat_send` is refused server-side with `chat_state{enabled:false, reason:"paused"}`.
- [ ] Seek backward; confirm the buddy's history no longer contains messages from after the new virtual time.
- [ ] `verify-chat-isolation.mjs` exits 0.
- [ ] With `chat_knowledge` still empty, a buddy still replies — degradation is graceful.

## Deliberately out of scope

- **Frontend UI.** The user asked for the backend and an interim testing platform; the dev harness is that platform.
- **The escalation tier's classifier call.** Task 7 ships the local tier only. `escalate` is returned and recorded; routing it to a cheap classifier is a follow-up, and the local tier is what prevents the distress case from being mishandled today.
- **Authoring `chat_knowledge` rows.** Tier 1 is editorial content, tracked separately.
