# IM Buddies — Plan A: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An authenticated, clock-gated `chat` WebSocket channel that delivers a buddy roster and presence changes, with no LLM generation anywhere in it.

**Architecture:** Nine new Directus collections seeded through `seed.mjs`. The streamer resolves the browser's existing `directus_session_token` cookie against the `directus_sessions` table over its current `pgxpool`, giving each `Session` a user UUID. A new `chat` channel joins the seven existing opt-in channels; on subscribe and on each tick it evaluates a pure availability gate and a pure online-set computation, emitting `chat_state`, `chat_roster`, and `chat_presence` frames. A static HTML dev page behind an env flag exercises the whole path in a real browser, which is the only place the httpOnly cookie works.

**Tech Stack:** Go 1.25, `gorilla/websocket`, `jackc/pgx/v5`, `vmihailenco/msgpack/v5`, `log/slog`. Directus 12 over REST from `seed.mjs` (Node). No new Go dependencies.

## Global Constraints

- Module is `classicy/streamer`; all non-entry code lives under `internal/`.
- **Never block the Hub.** Tick fan-out stays non-blocking (`select { case s.tickCh <- struct{}{}: default: }`).
- **`Session.send_` must never block.** Keep the non-blocking send with a logging `default`.
- **Hold `Session.mu` for the shortest possible window.** Take it, mutate, release, *then* call `send_`.
- **All times are UTC `time.Time`.** Wire format RFC3339. Never compare formatted time strings.
- **Nullable text columns scan into `*string`.** Directus emits `NULL` for empty strings; pgx cannot scan `NULL` into a non-pointer string.
- **Server→client frames are binary MessagePack; client→server frames are JSON text.** Do not flip either direction.
- **No backwards-compat shims.** One consumer, one producer. Wire changes update `docs/websocket-protocol.md` in the same commit.
- **`slog` everywhere**, loggers passed in, structured keys not formatted strings.
- **Import groups:** stdlib, then `classicy/streamer/...`, then third-party.
- **No comments that restate the code.** Comments explain *why*.
- Chat is a side channel and **must never take down media streaming**. Every wiring point in `cmd/server/main.go` is non-fatal.
- Chat window is `2001-09-11T12:00:00Z` to `2001-09-12T04:00:00Z` inclusive of start, exclusive of end.
- Run `go build ./... && go vet ./... && go test ./...` from `packages/backend/` before every commit.

---

### Task 1: Directus collections

**Files:**
- Modify: `packages/backend/seed.mjs`

**Interfaces:**
- Consumes: existing `api(token, method, path, body)`, `psql(sql)`, and `names` (the array of existing collection names) helpers in `seed.mjs`.
- Produces: nine collections — `chat_settings`, `chat_profiles`, `chat_beacons`, `chat_phases`, `chat_schedules`, `chat_knowledge`, `chat_transcript_segments`, `chat_messages`, `chat_blocks`. Later tasks read `chat_profiles` columns `id, screen_name, display_name, avatar, online_from, online_until, active, sort`.

- [ ] **Step 1: Add the chat collection block to `createCollections`**

Insert after the `tm_bookmarks` block. Each creation is guarded by `names.includes(...)` exactly like the surrounding code.

```js
  // ---- IM Buddies (see plans/2026-07-24-im-buddies-chatbot-design.md) ----
  // Nine collections: one settings singleton, four configuration tables, three
  // knowledge tiers (chat_knowledge + chat_transcript_segments; news_items is
  // tier 3 and already exists), and two per-user state tables.

  if (!names.includes("chat_settings")) {
    console.log("Creating collection: chat_settings");
    await api(token, "POST", "/collections", {
      collection: "chat_settings",
      meta: { icon: "settings", singleton: true, note: "Global LLM defaults for IM Buddies" },
      schema: {},
      fields: [
        { field: "id", type: "integer", schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true } },
        { field: "provider", type: "string", schema: { is_nullable: false, default_value: "anthropic" },
          meta: { interface: "select-dropdown", width: "half",
                  options: { choices: ["anthropic", "openai", "openrouter"].map((v) => ({ text: v, value: v })) } } },
        { field: "model", type: "string", schema: { is_nullable: false, default_value: "claude-opus-5" }, meta: { interface: "input", width: "half" } },
        { field: "max_tokens", type: "integer", schema: { is_nullable: false, default_value: 2000 }, meta: { interface: "input", width: "half" } },
        { field: "effort", type: "string", schema: { is_nullable: true, default_value: "low" }, meta: { interface: "input", width: "half" } },
        { field: "temperature", type: "float", schema: { is_nullable: true }, meta: { interface: "input", width: "half", note: "Ignored on Anthropic (Opus 5 rejects it)" } },
        { field: "openai_base_url", type: "text", schema: { is_nullable: true }, meta: { interface: "input", width: "full", note: "OpenRouter: https://openrouter.ai/api/v1" } },
      ],
    });
  } else {
    console.log("Collection chat_settings already exists, skipping.");
  }

  if (!names.includes("chat_profiles")) {
    console.log("Creating collection: chat_profiles");
    await api(token, "POST", "/collections", {
      collection: "chat_profiles",
      meta: { icon: "person", sort_field: "sort", note: "IM buddy personas" },
      schema: {},
      fields: [
        { field: "id", type: "integer", schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true } },
        { field: "screen_name", type: "string", schema: { is_nullable: false }, meta: { interface: "input", width: "half" } },
        { field: "display_name", type: "string", schema: { is_nullable: true }, meta: { interface: "input", width: "half" } },
        { field: "avatar", type: "text", schema: { is_nullable: true }, meta: { interface: "input", width: "full" } },
        { field: "persona", type: "text", schema: { is_nullable: true }, meta: { interface: "input-multiline", width: "full" } },
        { field: "education_level", type: "string", schema: { is_nullable: true },
          meta: { interface: "select-dropdown", width: "half",
                  options: { choices: ["elementary", "middle", "high", "college", "adult"].map((v) => ({ text: v, value: v })) } } },
        { field: "writing_style", type: "text", schema: { is_nullable: true }, meta: { interface: "input-multiline", width: "full" } },
        { field: "style_exemplars", type: "text", schema: { is_nullable: true }, meta: { interface: "input-multiline", width: "full", note: "A few sample messages in voice, one per line" } },
        { field: "location", type: "string", schema: { is_nullable: true }, meta: { interface: "input", width: "half" } },
        { field: "timezone", type: "string", schema: { is_nullable: true }, meta: { interface: "input", width: "half" } },
        { field: "online_from", type: "timestamp", schema: { is_nullable: true }, meta: { interface: "datetime", width: "half" } },
        { field: "online_until", type: "timestamp", schema: { is_nullable: true }, meta: { interface: "datetime", width: "half" } },
        { field: "typing_speed", type: "integer", schema: { is_nullable: true, default_value: 5 }, meta: { interface: "input", width: "half", note: "Characters per second; sets the reply-delay floor" } },
        { field: "system_prompt_extra", type: "text", schema: { is_nullable: true }, meta: { interface: "input-multiline", width: "full" } },
        { field: "provider", type: "string", schema: { is_nullable: true }, meta: { interface: "input", width: "half", note: "Null inherits chat_settings" } },
        { field: "model", type: "string", schema: { is_nullable: true }, meta: { interface: "input", width: "half", note: "Null inherits chat_settings" } },
        { field: "max_tokens", type: "integer", schema: { is_nullable: true }, meta: { interface: "input", width: "half", note: "Null inherits chat_settings" } },
        { field: "effort", type: "string", schema: { is_nullable: true }, meta: { interface: "input", width: "half", note: "Null inherits chat_settings" } },
        { field: "temperature", type: "float", schema: { is_nullable: true }, meta: { interface: "input", width: "half", note: "Null inherits chat_settings" } },
        { field: "active", type: "integer", schema: { is_nullable: false, default_value: 1 }, meta: { interface: "boolean", width: "half" } },
        { field: "sort", type: "integer", schema: { is_nullable: true }, meta: { hidden: true } },
      ],
    });
  } else {
    console.log("Collection chat_profiles already exists, skipping.");
  }

  if (!names.includes("chat_beacons")) {
    console.log("Creating collection: chat_beacons");
    await api(token, "POST", "/collections", {
      collection: "chat_beacons",
      meta: { icon: "flag", note: "Named story anchors. `at` = when it happened, `public_at` = when it became publicly known" },
      schema: {},
      fields: [
        { field: "id", type: "integer", schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true } },
        { field: "key", type: "string", schema: { is_nullable: false, is_unique: true }, meta: { interface: "input", width: "half" } },
        { field: "label", type: "string", schema: { is_nullable: true }, meta: { interface: "input", width: "half" } },
        { field: "at", type: "timestamp", schema: { is_nullable: false }, meta: { interface: "datetime", width: "half" } },
        { field: "public_at", type: "timestamp", schema: { is_nullable: false }, meta: { interface: "datetime", width: "half", note: "Phases advance on this, never on `at`" } },
        { field: "description", type: "text", schema: { is_nullable: true }, meta: { interface: "input-multiline", width: "full" } },
      ],
    });
  } else {
    console.log("Collection chat_beacons already exists, skipping.");
  }
```

- [ ] **Step 2: Add the remaining six collections**

Continue immediately after the block above, same file, same idiom.

```js
  if (!names.includes("chat_phases")) {
    console.log("Creating collection: chat_phases");
    await api(token, "POST", "/collections", {
      collection: "chat_phases",
      meta: { icon: "mood", sort_field: "sort", note: "Per-profile emotional arc, anchored to beacons" },
      schema: {},
      fields: [
        { field: "id", type: "integer", schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true } },
        { field: "profile", type: "integer", schema: { is_nullable: false }, meta: { interface: "select-dropdown-m2o", width: "half" } },
        { field: "from_beacon", type: "integer", schema: { is_nullable: true }, meta: { interface: "select-dropdown-m2o", width: "half", note: "Null = start of day" } },
        { field: "tone", type: "text", schema: { is_nullable: true }, meta: { interface: "input-multiline", width: "full" } },
        { field: "shock", type: "integer", schema: { is_nullable: false, default_value: 0 }, meta: { interface: "slider", width: "half", options: { minValue: 0, maxValue: 100 } } },
        { field: "coherence", type: "integer", schema: { is_nullable: false, default_value: 100 }, meta: { interface: "slider", width: "half", options: { minValue: 0, maxValue: 100 } } },
        { field: "verbosity", type: "integer", schema: { is_nullable: false, default_value: 50 }, meta: { interface: "slider", width: "half", options: { minValue: 0, maxValue: 100 } } },
        { field: "typo_rate", type: "integer", schema: { is_nullable: false, default_value: 10 }, meta: { interface: "slider", width: "half", options: { minValue: 0, maxValue: 100 } } },
        { field: "topic_focus", type: "integer", schema: { is_nullable: false, default_value: 0 }, meta: { interface: "slider", width: "half", options: { minValue: 0, maxValue: 100 } } },
        { field: "sort", type: "integer", schema: { is_nullable: true }, meta: { hidden: true } },
      ],
    });
  } else {
    console.log("Collection chat_phases already exists, skipping.");
  }

  if (!names.includes("chat_schedules")) {
    console.log("Creating collection: chat_schedules");
    await api(token, "POST", "/collections", {
      collection: "chat_schedules",
      meta: { icon: "schedule", note: "Proactive messages. Beacon-relative is the primary form; `at` overrides" },
      schema: {},
      fields: [
        { field: "id", type: "integer", schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true } },
        { field: "profile", type: "integer", schema: { is_nullable: false }, meta: { interface: "select-dropdown-m2o", width: "half" } },
        { field: "at_beacon", type: "integer", schema: { is_nullable: true }, meta: { interface: "select-dropdown-m2o", width: "half" } },
        { field: "offset_seconds", type: "integer", schema: { is_nullable: false, default_value: 0 }, meta: { interface: "input", width: "half" } },
        { field: "at", type: "timestamp", schema: { is_nullable: true }, meta: { interface: "datetime", width: "half", note: "Absolute override; wins over at_beacon" } },
        { field: "kind", type: "string", schema: { is_nullable: false, default_value: "generated" },
          meta: { interface: "select-dropdown", width: "half",
                  options: { choices: ["static", "generated"].map((v) => ({ text: v, value: v })) } } },
        { field: "text", type: "text", schema: { is_nullable: true }, meta: { interface: "input-multiline", width: "full", note: "kind=static" } },
        { field: "prompt", type: "text", schema: { is_nullable: true }, meta: { interface: "input-multiline", width: "full", note: "kind=generated" } },
        { field: "requires_prior_contact", type: "integer", schema: { is_nullable: false, default_value: 0 }, meta: { interface: "boolean", width: "half" } },
        { field: "active", type: "integer", schema: { is_nullable: false, default_value: 1 }, meta: { interface: "boolean", width: "half" } },
      ],
    });
  } else {
    console.log("Collection chat_schedules already exists, skipping.");
  }

  if (!names.includes("chat_knowledge")) {
    console.log("Creating collection: chat_knowledge");
    await api(token, "POST", "/collections", {
      collection: "chat_knowledge",
      meta: { icon: "fact_check", note: "Tier 1 — curated public-knowledge timeline" },
      schema: {},
      fields: [
        { field: "id", type: "integer", schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true } },
        { field: "public_at", type: "timestamp", schema: { is_nullable: false }, meta: { interface: "datetime", width: "half" } },
        { field: "until", type: "timestamp", schema: { is_nullable: true }, meta: { interface: "datetime", width: "half", note: "When this stopped being current or was corrected" } },
        { field: "summary", type: "text", schema: { is_nullable: false }, meta: { interface: "input-multiline", width: "full" } },
        { field: "detail", type: "text", schema: { is_nullable: true }, meta: { interface: "input-multiline", width: "full" } },
        { field: "certainty", type: "string", schema: { is_nullable: false, default_value: "reported" },
          meta: { interface: "select-dropdown", width: "half",
                  options: { choices: ["rumor", "reported", "confirmed"].map((v) => ({ text: v, value: v })) } } },
        { field: "sensitivity", type: "string", schema: { is_nullable: false, default_value: "normal" },
          meta: { interface: "select-dropdown", width: "half",
                  options: { choices: ["normal", "handle_with_care", "do_not_discuss"].map((v) => ({ text: v, value: v })) } } },
        { field: "topics", type: "text", schema: { is_nullable: true }, meta: { interface: "input", width: "full", note: "Comma-separated" } },
      ],
    });
  } else {
    console.log("Collection chat_knowledge already exists, skipping.");
  }

  if (!names.includes("chat_transcript_segments")) {
    console.log("Creating collection: chat_transcript_segments");
    await api(token, "POST", "/collections", {
      collection: "chat_transcript_segments",
      meta: { icon: "closed_caption", note: "Tier 2 — broadcast transcript segments, produced by video-grabber" },
      schema: {},
      fields: [
        { field: "id", type: "integer", schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true } },
        { field: "channel", type: "integer", schema: { is_nullable: true }, meta: { interface: "select-dropdown-m2o", width: "half" } },
        { field: "channel_slug", type: "string", schema: { is_nullable: true }, meta: { interface: "input", width: "half", note: "Used for radio, which has no tv_channels row" } },
        { field: "medium", type: "string", schema: { is_nullable: false, default_value: "tv" },
          meta: { interface: "select-dropdown", width: "half",
                  options: { choices: ["tv", "radio"].map((v) => ({ text: v, value: v })) } } },
        { field: "start_date", type: "timestamp", schema: { is_nullable: false }, meta: { interface: "datetime", width: "half" } },
        { field: "end_date", type: "timestamp", schema: { is_nullable: true }, meta: { interface: "datetime", width: "half" } },
        { field: "text", type: "text", schema: { is_nullable: false }, meta: { interface: "input-multiline", width: "full" } },
      ],
    });
  } else {
    console.log("Collection chat_transcript_segments already exists, skipping.");
  }

  if (!names.includes("chat_messages")) {
    console.log("Creating collection: chat_messages");
    await api(token, "POST", "/collections", {
      collection: "chat_messages",
      meta: { icon: "chat", note: "Per-user conversation log. Directus policy MUST scope this to $CURRENT_USER" },
      schema: {},
      fields: [
        { field: "id", type: "integer", schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true } },
        { field: "user", type: "uuid", schema: { is_nullable: false }, meta: { interface: "select-dropdown-m2o", width: "half" } },
        { field: "profile", type: "integer", schema: { is_nullable: false }, meta: { interface: "select-dropdown-m2o", width: "half" } },
        { field: "direction", type: "string", schema: { is_nullable: false },
          meta: { interface: "select-dropdown", width: "half",
                  options: { choices: ["in", "out"].map((v) => ({ text: v, value: v })) } } },
        { field: "body", type: "text", schema: { is_nullable: false }, meta: { interface: "input-multiline", width: "full" } },
        { field: "virtual_time", type: "timestamp", schema: { is_nullable: false }, meta: { interface: "datetime", width: "half", note: "Position on the 2001 clock" } },
        { field: "created_at", type: "timestamp", schema: { is_nullable: false }, meta: { interface: "datetime", width: "half", note: "Real wall-clock time" } },
        { field: "kind", type: "string", schema: { is_nullable: false, default_value: "typed" },
          meta: { interface: "select-dropdown", width: "half",
                  options: { choices: ["typed", "scheduled", "generated", "static", "stall"].map((v) => ({ text: v, value: v })) } } },
        { field: "moderation", type: "json", schema: { is_nullable: true }, meta: { interface: "input-code", width: "full", special: ["cast-json"] } },
        { field: "model", type: "string", schema: { is_nullable: true }, meta: { interface: "input", width: "half" } },
        { field: "tokens_in", type: "integer", schema: { is_nullable: true }, meta: { interface: "input", width: "half" } },
        { field: "tokens_out", type: "integer", schema: { is_nullable: true }, meta: { interface: "input", width: "half" } },
      ],
    });
  } else {
    console.log("Collection chat_messages already exists, skipping.");
  }

  if (!names.includes("chat_blocks")) {
    console.log("Creating collection: chat_blocks");
    await api(token, "POST", "/collections", {
      collection: "chat_blocks",
      meta: { icon: "block", note: "Moderation blocks. Directus policy MUST scope this to $CURRENT_USER" },
      schema: {},
      fields: [
        { field: "id", type: "integer", schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true } },
        { field: "user", type: "uuid", schema: { is_nullable: false }, meta: { interface: "select-dropdown-m2o", width: "half" } },
        { field: "scope", type: "string", schema: { is_nullable: false, default_value: "profile" },
          meta: { interface: "select-dropdown", width: "half",
                  options: { choices: ["profile", "global"].map((v) => ({ text: v, value: v })) } } },
        { field: "profile", type: "integer", schema: { is_nullable: true }, meta: { interface: "select-dropdown-m2o", width: "half" } },
        { field: "reason", type: "text", schema: { is_nullable: true }, meta: { interface: "input-multiline", width: "full" } },
        { field: "evidence", type: "text", schema: { is_nullable: true }, meta: { interface: "input-multiline", width: "full" } },
        { field: "created_at", type: "timestamp", schema: { is_nullable: false }, meta: { interface: "datetime", width: "half" } },
        { field: "expires", type: "timestamp", schema: { is_nullable: true }, meta: { interface: "datetime", width: "half", note: "Null = permanent" } },
      ],
    });
  } else {
    console.log("Collection chat_blocks already exists, skipping.");
  }
```

- [ ] **Step 3: Add the indexes**

Add to the existing `psql(...)` index block (the one containing `idx_news_items_approved_start`).

```js
    CREATE INDEX IF NOT EXISTS idx_chat_knowledge_public   ON chat_knowledge (public_at);
    CREATE INDEX IF NOT EXISTS idx_chat_transcript_start   ON chat_transcript_segments (start_date);
    CREATE INDEX IF NOT EXISTS idx_chat_transcript_fts     ON chat_transcript_segments USING GIN (to_tsvector('english', text));
    CREATE INDEX IF NOT EXISTS idx_chat_messages_user_conv ON chat_messages (( "user" ), profile, virtual_time);
    CREATE INDEX IF NOT EXISTS idx_chat_blocks_user        ON chat_blocks (( "user" ), scope);
    CREATE INDEX IF NOT EXISTS idx_chat_schedules_profile  ON chat_schedules (profile, active);
    CREATE INDEX IF NOT EXISTS idx_chat_phases_profile     ON chat_phases (profile, sort);
```

`user` is a reserved word in Postgres and must stay quoted everywhere it appears.

- [ ] **Step 4: Run the seed against a dev Directus and verify**

Run: `cd packages/backend && node seed.mjs`
Expected: nine `Creating collection: chat_*` lines, no errors. Re-running prints `already exists, skipping.` for all nine — the seed is idempotent.

Then verify the schema landed, substituting your dev connection string:

```sh
psql "$PSQL_URL" -c "
select table_name, count(*) as columns
from information_schema.columns
where table_name like 'chat\_%'
group by table_name order by table_name;"
```

Expected: nine rows. `chat_profiles` has 21 columns, `chat_messages` has 12, `chat_blocks` has 8.

```sh
psql "$PSQL_URL" -c "select indexname from pg_indexes where tablename like 'chat\_%' order by indexname;"
```

Expected: includes `idx_chat_transcript_fts` and `idx_chat_messages_user_conv`.

- [ ] **Step 5: Set Directus permissions**

In the Directus admin UI under Settings → Access Policies:

- **Public policy:** grant `read` on `chat_profiles`, `chat_beacons`, `chat_phases`, `chat_schedules`, `chat_knowledge`, `chat_transcript_segments`. Grant nothing on `chat_settings`, `chat_messages`, or `chat_blocks`.
- **Teacher/authenticated policy:** on `chat_messages` and `chat_blocks`, grant `read` and `create` with the item filter `{"user": {"_eq": "$CURRENT_USER"}}`.
- **`chat_settings`:** administrator only, both directions. It holds no credentials but is operational config with direct cost implications.

Verify the scoping actually holds — this is the step that prevents one student reading another's conversation. With two different users' session tokens:

```sh
# As user A, create a row (replace TOKEN_A and the profile id):
curl -s -X POST "$DIRECTUS_URL/items/chat_messages" \
  -H "Authorization: Bearer $TOKEN_A" -H "Content-Type: application/json" \
  -d '{"user":"USER_A_UUID","profile":1,"direction":"in","body":"probe",
       "virtual_time":"2001-09-11T13:00:00Z","created_at":"2026-07-24T00:00:00Z","kind":"typed"}'

# As user B, attempt to read it:
curl -s "$DIRECTUS_URL/items/chat_messages" -H "Authorization: Bearer $TOKEN_B"
```

Expected: user B's response `data` array does **not** contain the probe row. If it does, the policy filter is wrong — fix it before continuing; no later task will catch this.

- [ ] **Step 6: Commit**

```bash
git add packages/backend/seed.mjs
git commit -m "feat(chat): add IM Buddies Directus collections to seed"
```

---

### Task 2: Buddy model and profile registry

**Files:**
- Create: `packages/backend/internal/model/chat.go`
- Create: `packages/backend/internal/chat/profile.go`
- Create: `packages/backend/internal/chat/profile_test.go`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `model.Buddy` — the wire shape, fields `ID int`, `ScreenName string`, `DisplayName string`, `Avatar string`, `Online bool`.
  - `chat.Profile` — config record with `ID int`, `ScreenName string`, `DisplayName string`, `Avatar string`, `OnlineFrom *time.Time`, `OnlineUntil *time.Time`, `Sort int`.
  - `chat.WindowStart`, `chat.WindowEnd` — `time.Time` package vars.
  - `func (p Profile) OnlineAt(t time.Time) bool`
  - `func Roster(profiles []Profile, t time.Time) []model.Buddy`
  - `func LoadProfiles(ctx context.Context, pool *pgxpool.Pool) ([]Profile, error)`

- [ ] **Step 1: Write the failing test**

Create `packages/backend/internal/chat/profile_test.go`:

```go
package chat

import (
	"testing"
	"time"
)

func at(hhmm string) time.Time {
	t, err := time.Parse(time.RFC3339, "2001-09-11T"+hhmm+":00Z")
	if err != nil {
		panic(err)
	}
	return t
}

func ptr(t time.Time) *time.Time { return &t }

func TestProfileOnlineAt(t *testing.T) {
	tests := []struct {
		name  string
		p     Profile
		when  time.Time
		want  bool
	}{
		{"no bounds is online across the whole window", Profile{}, at("14:00"), true},
		{"no bounds is offline before the window", Profile{}, at("11:59"), false},
		{"no bounds is offline at the window end", Profile{}, mustParse("2001-09-12T04:00:00Z"), false},
		{"no bounds is online at the window start", Profile{}, at("12:00"), true},
		{"after online_from", Profile{OnlineFrom: ptr(at("13:15"))}, at("13:16"), true},
		{"before online_from", Profile{OnlineFrom: ptr(at("13:15"))}, at("13:14"), false},
		{"exactly at online_from", Profile{OnlineFrom: ptr(at("13:15"))}, at("13:15"), true},
		{"before online_until", Profile{OnlineUntil: ptr(at("20:00"))}, at("19:59"), true},
		{"exactly at online_until is offline", Profile{OnlineUntil: ptr(at("20:00"))}, at("20:00"), false},
		{"inside both bounds", Profile{OnlineFrom: ptr(at("13:00")), OnlineUntil: ptr(at("15:00"))}, at("14:00"), true},
		{"outside both bounds", Profile{OnlineFrom: ptr(at("13:00")), OnlineUntil: ptr(at("15:00"))}, at("16:00"), false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.p.OnlineAt(tc.when); got != tc.want {
				t.Fatalf("OnlineAt(%s) = %v, want %v", tc.when.Format(time.RFC3339), got, tc.want)
			}
		})
	}
}

func mustParse(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

func TestRosterPreservesSortAndMarksOnline(t *testing.T) {
	profiles := []Profile{
		{ID: 2, ScreenName: "skaterboi1988", Sort: 1, OnlineFrom: ptr(at("13:00"))},
		{ID: 5, ScreenName: "mom", Sort: 0},
	}
	got := Roster(profiles, at("12:30"))

	if len(got) != 2 {
		t.Fatalf("Roster length = %d, want 2", len(got))
	}
	if got[0].ScreenName != "mom" {
		t.Fatalf("Roster[0] = %q, want mom (lower sort first)", got[0].ScreenName)
	}
	if !got[0].Online {
		t.Fatal("mom should be online at 12:30")
	}
	if got[1].Online {
		t.Fatal("skaterboi1988 should be offline at 12:30 (online_from 13:00)")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/backend && go test ./internal/chat/... -run 'TestProfile|TestRoster' -v`
Expected: FAIL — the package does not compile, `undefined: Profile`.

- [ ] **Step 3: Write the wire model**

Create `packages/backend/internal/model/chat.go`:

```go
package model

// Buddy is one entry in the chat channel's roster frame. It is the wire
// projection of chat.Profile — the config record carries authoring fields the
// client has no use for.
type Buddy struct {
	ID          int    `json:"id"`
	ScreenName  string `json:"screen_name"`
	DisplayName string `json:"display_name,omitempty"`
	Avatar      string `json:"avatar,omitempty"`
	Online      bool   `json:"online"`
}
```

- [ ] **Step 4: Write the profile implementation**

Create `packages/backend/internal/chat/profile.go`:

```go
package chat

import (
	"context"
	"fmt"
	"sort"
	"time"

	"classicy/streamer/internal/model"

	"github.com/jackc/pgx/v5/pgxpool"
)

// The chat channel exists only inside this window: 8 AM to midnight ET on
// September 11, 2001. Outside it every buddy is offline and sends are refused.
var (
	WindowStart = time.Date(2001, 9, 11, 12, 0, 0, 0, time.UTC)
	WindowEnd   = time.Date(2001, 9, 12, 4, 0, 0, 0, time.UTC)
)

// Profile is one configured buddy. Plan A uses only the identity and
// availability fields; persona, style, and LLM overrides are loaded by the
// generation layer in a later plan.
type Profile struct {
	ID          int
	ScreenName  string
	DisplayName string
	Avatar      string
	OnlineFrom  *time.Time
	OnlineUntil *time.Time
	Sort        int
}

// OnlineAt reports whether this buddy is signed on at virtual time t. A nil
// bound means "the whole chat window", so a profile with no bounds is online
// for all of it and never outside it.
func (p Profile) OnlineAt(t time.Time) bool {
	if t.Before(WindowStart) || !t.Before(WindowEnd) {
		return false
	}
	if p.OnlineFrom != nil && t.Before(*p.OnlineFrom) {
		return false
	}
	if p.OnlineUntil != nil && !t.Before(*p.OnlineUntil) {
		return false
	}
	return true
}

// Roster projects profiles to their wire shape at virtual time t, ordered by
// the sort field the Directus admin controls.
func Roster(profiles []Profile, t time.Time) []model.Buddy {
	ordered := make([]Profile, len(profiles))
	copy(ordered, profiles)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Sort < ordered[j].Sort })

	out := make([]model.Buddy, 0, len(ordered))
	for _, p := range ordered {
		out = append(out, model.Buddy{
			ID:          p.ID,
			ScreenName:  p.ScreenName,
			DisplayName: p.DisplayName,
			Avatar:      p.Avatar,
			Online:      p.OnlineAt(t),
		})
	}
	return out
}

const profileSelect = `
	SELECT id, screen_name, display_name, avatar, online_from, online_until, sort
	FROM chat_profiles
	WHERE active = 1
	ORDER BY sort NULLS LAST, id`

// LoadProfiles reads every active buddy. Config is tiny and static, so callers
// load once and keep the slice rather than querying per tick.
func LoadProfiles(ctx context.Context, pool *pgxpool.Pool) ([]Profile, error) {
	rows, err := pool.Query(ctx, profileSelect)
	if err != nil {
		return nil, fmt.Errorf("query chat_profiles: %w", err)
	}
	defer rows.Close()

	var out []Profile
	for rows.Next() {
		var (
			p           Profile
			displayName *string
			avatar      *string
			sortOrder   *int
		)
		if err := rows.Scan(&p.ID, &p.ScreenName, &displayName, &avatar,
			&p.OnlineFrom, &p.OnlineUntil, &sortOrder); err != nil {
			return nil, fmt.Errorf("scan chat_profiles: %w", err)
		}
		p.DisplayName = derefStr(displayName)
		p.Avatar = derefStr(avatar)
		if sortOrder != nil {
			p.Sort = *sortOrder
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate chat_profiles: %w", err)
	}
	return out, nil
}

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/backend && go test ./internal/chat/... -v`
Expected: PASS, all subtests green.

- [ ] **Step 6: Build and vet, then commit**

Run: `cd packages/backend && go build ./... && go vet ./...`
Expected: no output.

```bash
git add packages/backend/internal/model/chat.go packages/backend/internal/chat/
git commit -m "feat(chat): add Profile, Buddy, and roster projection"
```

---

### Task 3: Availability gate

**Files:**
- Create: `packages/backend/internal/chat/availability.go`
- Create: `packages/backend/internal/chat/availability_test.go`

**Interfaces:**
- Consumes: `chat.WindowStart`, `chat.WindowEnd` from Task 2.
- Produces:
  - `chat.Gate` struct with fields `VirtualTime time.Time`, `ClockSet bool`, `Paused bool`, `SignedIn bool`, `Blocked bool`.
  - `func Available(g Gate) (enabled bool, reason string)` returning one of `ok`, `not_signed_in`, `blocked`, `outside_window`, `paused`.

- [ ] **Step 1: Write the failing test**

Create `packages/backend/internal/chat/availability_test.go`:

```go
package chat

import "testing"

func TestAvailable(t *testing.T) {
	base := Gate{VirtualTime: at("14:00"), ClockSet: true, SignedIn: true}

	tests := []struct {
		name       string
		mutate     func(*Gate)
		wantOK     bool
		wantReason string
	}{
		{"signed in, mid-window, running", func(g *Gate) {}, true, "ok"},
		{"not signed in", func(g *Gate) { g.SignedIn = false }, false, "not_signed_in"},
		{"blocked", func(g *Gate) { g.Blocked = true }, false, "blocked"},
		{"paused", func(g *Gate) { g.Paused = true }, false, "paused"},
		{"before the window", func(g *Gate) { g.VirtualTime = at("11:59") }, false, "outside_window"},
		{"at the window end", func(g *Gate) { g.VirtualTime = mustParse("2001-09-12T04:00:00Z") }, false, "outside_window"},
		{"clock not yet set", func(g *Gate) { g.ClockSet = false }, false, "outside_window"},
		{"not signed in outranks blocked", func(g *Gate) { g.SignedIn = false; g.Blocked = true }, false, "not_signed_in"},
		{"blocked outranks outside_window", func(g *Gate) { g.Blocked = true; g.VirtualTime = at("11:00") }, false, "blocked"},
		{"outside_window outranks paused", func(g *Gate) { g.Paused = true; g.VirtualTime = at("11:00") }, false, "outside_window"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			g := base
			tc.mutate(&g)
			ok, reason := Available(g)
			if ok != tc.wantOK || reason != tc.wantReason {
				t.Fatalf("Available() = (%v, %q), want (%v, %q)", ok, reason, tc.wantOK, tc.wantReason)
			}
		})
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/backend && go test ./internal/chat/... -run TestAvailable -v`
Expected: FAIL — `undefined: Gate`.

- [ ] **Step 3: Write the implementation**

Create `packages/backend/internal/chat/availability.go`:

```go
package chat

import "time"

// Gate is every condition that decides whether a signed-in user may type. It is
// evaluated server-side on subscribe, pause, resume, seek, and window
// boundaries; the client disables its input from the resulting frame, but the
// server refusing is what actually enforces the rule.
type Gate struct {
	VirtualTime time.Time
	ClockSet    bool
	Paused      bool
	SignedIn    bool
	Blocked     bool
}

// Available reports whether chat is usable and, when it is not, the single
// reason to show. Reasons are ordered most to least fundamental so a user who
// is both signed out and outside the window is told the actionable thing.
func Available(g Gate) (bool, string) {
	switch {
	case !g.SignedIn:
		return false, "not_signed_in"
	case g.Blocked:
		return false, "blocked"
	case !g.ClockSet, g.VirtualTime.Before(WindowStart), !g.VirtualTime.Before(WindowEnd):
		return false, "outside_window"
	case g.Paused:
		return false, "paused"
	}
	return true, "ok"
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/backend && go test ./internal/chat/... -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/internal/chat/availability.go packages/backend/internal/chat/availability_test.go
git commit -m "feat(chat): add availability gate"
```

---

### Task 4: Resolve the Directus session cookie

**Files:**
- Create: `packages/backend/internal/db/directus_session.go`
- Create: `packages/backend/internal/db/directus_session_test.go`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `db.SessionCookieName` — const `"directus_session_token"`.
  - `func db.SessionTokenFrom(r *http.Request) string` — empty string when absent.
  - `func db.LookupSessionUser(ctx context.Context, pool *pgxpool.Pool, token string) (string, error)` — returns the user UUID, or `("", nil)` when the token is unknown, expired, or belongs to a share link.

- [ ] **Step 1: Write the failing test**

Create `packages/backend/internal/db/directus_session_test.go`:

```go
package db

import (
	"net/http"
	"testing"
)

func TestSessionTokenFrom(t *testing.T) {
	tests := []struct {
		name   string
		cookie *http.Cookie
		want   string
	}{
		{"no cookie", nil, ""},
		{"session cookie present", &http.Cookie{Name: SessionCookieName, Value: "abc123"}, "abc123"},
		{"unrelated cookie", &http.Cookie{Name: "other", Value: "xyz"}, ""},
		{"empty value", &http.Cookie{Name: SessionCookieName, Value: ""}, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r, err := http.NewRequest(http.MethodGet, "/stream", nil)
			if err != nil {
				t.Fatal(err)
			}
			if tc.cookie != nil {
				r.AddCookie(tc.cookie)
			}
			if got := SessionTokenFrom(r); got != tc.want {
				t.Fatalf("SessionTokenFrom() = %q, want %q", got, tc.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/backend && go test ./internal/db/... -run TestSessionTokenFrom -v`
Expected: FAIL — `undefined: SessionCookieName`.

- [ ] **Step 3: Write the implementation**

Create `packages/backend/internal/db/directus_session.go`:

```go
package db

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// SessionCookieName is Directus's default session cookie. The frontend logs in
// with mode:"session" and SESSION_COOKIE_DOMAIN is ".911realtime.org", so the
// browser sends this on the WebSocket upgrade to stream-beta — cross-origin but
// same-site, which SameSite=lax permits.
const SessionCookieName = "directus_session_token"

// SessionTokenFrom pulls the Directus session token off an upgrade request.
func SessionTokenFrom(r *http.Request) string {
	c, err := r.Cookie(SessionCookieName)
	if err != nil {
		return ""
	}
	return c.Value
}

// LookupSessionUser resolves a session token to a Directus user UUID.
//
// This reads a Directus-internal table rather than calling the Directus API: the
// streamer already holds a pgxpool, and the API path has a documented history of
// latency and edge-caching problems here. The coupling is deliberate — a Directus
// major-version upgrade must re-verify this query.
//
// An unknown or expired token is not an error; it means "anonymous". Share-link
// sessions have a NULL user and are treated the same way.
func LookupSessionUser(ctx context.Context, pool *pgxpool.Pool, token string) (string, error) {
	if token == "" {
		return "", nil
	}
	var user *string
	err := pool.QueryRow(ctx,
		`SELECT "user" FROM directus_sessions WHERE token = $1 AND expires > now()`,
		token).Scan(&user)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("lookup directus session: %w", err)
	}
	if user == nil {
		return "", nil
	}
	return *user, nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/backend && go test ./internal/db/... -v`
Expected: PASS, including the pre-existing `sources_cache` tests.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/internal/db/directus_session.go packages/backend/internal/db/directus_session_test.go
git commit -m "feat(chat): resolve directus_session_token to a user id"
```

---

### Task 5: Chat channel on Session

**Files:**
- Modify: `packages/backend/internal/session/session.go`
- Modify: `packages/backend/internal/session/session_test.go`

**Interfaces:**
- Consumes: `chat.Gate`, `chat.Available`, `chat.Profile`, `chat.Roster`, `model.Buddy` from Tasks 2–3.
- Produces:
  - `session.ChannelChat` — const `"chat"`.
  - `func (s *Session) SetUser(id string)` and `func (s *Session) UserID() string`.
  - `func (s *Session) SetProfiles(p []chat.Profile)`.
  - `func (s *Session) SendChatState()` — computes the gate and emits a `chat_state` frame.
  - `func (s *Session) SendChatRoster()` — emits a `chat_roster` frame.
  - `func (s *Session) syncChatPresence()` — emits `chat_presence` for any buddy whose online state changed since the last call. Called from `RunTimePump`.
  - `outMsg` gains `Enabled *bool`, `Reason string`, `Buddies []model.Buddy`, `Profile int`, `Online *bool`.

- [ ] **Step 1: Write the failing test**

Append to `packages/backend/internal/session/session_test.go`:

```go
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
```

`newTestSession(t)` and `recvType(t, s)` already exist at the top of `session_test.go` — do **not** redefine them. `drain` does not exist; add it next to `recvType`:

```go
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
```

Add `classicy/streamer/internal/chat` to `session_test.go`'s module import group. The file already imports `model`, `time`, and `testing`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/backend && go test ./internal/session/... -run TestChat -v`
Expected: FAIL — `undefined: (*Session).SendChatState`.

- [ ] **Step 3: Extend `outMsg`**

In `packages/backend/internal/session/session.go`, add to the `outMsg` struct after the `MasterTime` field:

```go
	// Chat channel. Enabled/Reason ride chat_state; Buddies rides chat_roster;
	// Profile/Online ride chat_presence. Enabled and Online are pointers so a
	// false value is transmitted rather than dropped by omitempty.
	Enabled *bool         `json:"enabled,omitempty"`
	Reason  string        `json:"reason,omitempty"`
	Buddies []model.Buddy `json:"buddies,omitempty"`
	Profile int           `json:"profile,omitempty"`
	Online  *bool         `json:"online,omitempty"`
```

- [ ] **Step 4: Add the channel constant and session fields**

Add `ChannelChat = "chat"` to the channel const block. Add to the `Session` struct:

```go
	userID       string
	profiles     []chat.Profile
	presenceSeen map[int]bool
```

Add the `classicy/streamer/internal/chat` import to the module import group.

- [ ] **Step 5: Write the implementation**

Add to `packages/backend/internal/session/session.go`:

```go
// SetUser records the Directus user this connection authenticated as. An empty
// id means anonymous, which is the steady state for most visitors — only the
// chat channel requires an identity.
func (s *Session) SetUser(id string) {
	s.mu.Lock()
	s.userID = id
	s.mu.Unlock()
}

// UserID returns the authenticated Directus user id, or "" when anonymous.
func (s *Session) UserID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.userID
}

// SetProfiles installs the buddy roster for this session. Config is loaded once
// at connect time and handed in; sessions never query for it.
func (s *Session) SetProfiles(p []chat.Profile) {
	s.mu.Lock()
	s.profiles = p
	s.mu.Unlock()
}

// SendChatState emits the gate the client binds its input's disabled state to.
func (s *Session) SendChatState() {
	s.mu.Lock()
	g := chat.Gate{
		VirtualTime: s.virtualTime,
		ClockSet:    !s.virtualTime.IsZero(),
		Paused:      s.paused,
		SignedIn:    s.userID != "",
	}
	s.mu.Unlock()

	enabled, reason := chat.Available(g)
	s.send_(outMsg{Type: "chat_state", Enabled: &enabled, Reason: reason})
}

// SendChatRoster emits the full buddy list with each buddy's online state at the
// current virtual time.
func (s *Session) SendChatRoster() {
	s.mu.Lock()
	profiles, t := s.profiles, s.virtualTime
	s.mu.Unlock()

	buddies := chat.Roster(profiles, t)

	s.mu.Lock()
	if s.presenceSeen == nil {
		s.presenceSeen = make(map[int]bool, len(buddies))
	}
	for _, b := range buddies {
		s.presenceSeen[b.ID] = b.Online
	}
	s.mu.Unlock()

	s.send_(outMsg{Type: "chat_roster", Buddies: buddies})
}

// syncChatPresence emits one chat_presence frame per buddy whose online state
// changed since the last call. Most ticks emit nothing, so this stays cheap on
// the tick path.
func (s *Session) syncChatPresence() {
	s.mu.Lock()
	if _, ok := s.subscriptions[ChannelChat]; !ok {
		s.mu.Unlock()
		return
	}
	profiles, t := s.profiles, s.virtualTime
	if s.presenceSeen == nil {
		s.presenceSeen = make(map[int]bool, len(profiles))
	}
	var changed []model.Buddy
	for _, p := range profiles {
		online := p.OnlineAt(t)
		if was, seen := s.presenceSeen[p.ID]; !seen || was != online {
			s.presenceSeen[p.ID] = online
			changed = append(changed, model.Buddy{ID: p.ID, ScreenName: p.ScreenName, Online: online})
		}
	}
	s.mu.Unlock()

	for _, b := range changed {
		online := b.Online
		s.send_(outMsg{Type: "chat_presence", Profile: b.ID, Online: &online})
	}
}
```

- [ ] **Step 6: Call `syncChatPresence` from the tick and the clock transitions**

In `RunTimePump`, inside the tick branch that already advances `virtualTime`, after the existing per-channel refill planning, add:

```go
			s.syncChatPresence()
```

In `Pause()` and `Resume()`, after the existing `s.mu.Unlock()`, add:

```go
	s.SendChatState()
```

In `Init` and `Seek`, after the existing horizon reset and unlock, add:

```go
	s.SendChatState()
	s.syncChatPresence()
```

Seeking outside the window must move buddies offline, which is exactly what `syncChatPresence` does once `virtualTime` has moved.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd packages/backend && go test ./internal/session/... -v`
Expected: PASS, including all pre-existing session tests.

- [ ] **Step 8: Build, vet, and commit**

Run: `cd packages/backend && go build ./... && go vet ./... && go test ./...`
Expected: no output from build/vet; all tests pass.

```bash
git add packages/backend/internal/session/
git commit -m "feat(chat): add chat channel state, roster, and presence to Session"
```

---

### Task 6: Wire the channel into the handler

**Files:**
- Modify: `packages/backend/internal/handler/ws.go`
- Modify: `packages/backend/cmd/server/main.go`
- Modify: `packages/backend/docs/websocket-protocol.md`

**Interfaces:**
- Consumes: everything from Tasks 2–5.
- Produces: a `chat` channel that rejects `subscribe` from anonymous sessions and, on success, emits `chat_state` then `chat_roster`.

- [ ] **Step 1: Resolve the user at upgrade time**

In `NewWSHandler`, immediately after `sess := session.NewSession(hub, rdb, pool, logger)` and before `hub.Register(sess)`:

```go
		// Chat is the only channel that needs an identity. Resolving it here (not
		// on subscribe) keeps the lookup off the message path, and a failure is
		// non-fatal: the session stays anonymous and every other channel works.
		if token := db.SessionTokenFrom(r); token != "" {
			if uid, err := db.LookupSessionUser(r.Context(), pool, token); err != nil {
				logger.Warn("directus session lookup failed", "error", err)
			} else if uid != "" {
				sess.SetUser(uid)
			}
		}
		sess.SetProfiles(chatProfiles.Get())
```

- [ ] **Step 2: Accept `chat` as a known channel**

In `knownChannel`, add the new channel:

```go
func knownChannel(ch string) bool {
	return ch == session.ChannelPager || ch == session.ChannelMp3 ||
		ch == session.ChannelNews || ch == session.ChannelUsenet ||
		ch == session.ChannelFlights || ch == session.ChannelWeather ||
		ch == session.ChannelAlerts || ch == session.ChannelChat
}
```

- [ ] **Step 3: Gate the subscribe and send the snapshot**

In the `case "subscribe":` block, replace the body after the `knownChannel` guard with:

```go
				if cmsg.Channel == session.ChannelChat && sess.UserID() == "" {
					sess.SendChatState()
					continue
				}
				sess.Subscribe(cmsg.Channel)
				if cmsg.Channel == session.ChannelChat {
					sess.SendChatState()
					sess.SendChatRoster()
					continue
				}
				// Deliver an immediate snapshot at the current virtual time so the
				// client gets the active items without waiting for the next tick.
				if t, ok := sess.VirtualTime(); ok {
					sendChannelSnapshot(r, sess, pool, rdb, cmsg.Channel, t, logger)
				}
```

An anonymous subscribe is answered with `chat_state{enabled:false, reason:"not_signed_in"}` rather than an error frame, because the client needs the reason to render its disabled input either way.

- [ ] **Step 4: Add the profile cache and load it at boot**

Add to `packages/backend/internal/handler/ws.go`, above `NewWSHandler`:

```go
// ProfileCache holds the buddy roster for the life of the process. Chat config
// is tiny and static; every connection reads the same slice rather than querying.
type ProfileCache struct {
	mu       sync.RWMutex
	profiles []chat.Profile
}

func NewProfileCache() *ProfileCache { return &ProfileCache{} }

func (c *ProfileCache) Get() []chat.Profile {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.profiles
}

func (c *ProfileCache) Set(p []chat.Profile) {
	c.mu.Lock()
	c.profiles = p
	c.mu.Unlock()
}
```

Change the `NewWSHandler` signature to accept it:

```go
func NewWSHandler(hub *session.Hub, rdb *goredis.Client, pool *pgxpool.Pool, sources *db.SourcesCache, chatProfiles *ProfileCache, logger *slog.Logger) http.HandlerFunc {
```

Add `sync` to the stdlib import group and `classicy/streamer/internal/chat` to the module group.

In `packages/backend/cmd/server/main.go`, before the `mux.HandleFunc("/stream", ...)` line:

```go
	// Chat profiles are a side channel: a load failure must not stop the streamer.
	chatProfiles := handler.NewProfileCache()
	if profiles, err := chat.LoadProfiles(ctx, pool); err != nil {
		logger.Warn("chat profiles unavailable, chat roster will be empty", "error", err)
	} else {
		chatProfiles.Set(profiles)
		logger.Info("chat profiles loaded", "count", len(profiles))
	}
```

Update the handler registration:

```go
	mux.HandleFunc("/stream", handler.NewWSHandler(hub, rdb, pool, sourcesCache, chatProfiles, logger))
```

Add `classicy/streamer/internal/chat` to `main.go`'s module import group.

- [ ] **Step 5: Build and run the full suite**

Run: `cd packages/backend && go build ./... && go vet ./... && go test ./...`
Expected: no output from build/vet; all tests pass.

- [ ] **Step 6: Document the wire additions**

Add to `packages/backend/docs/websocket-protocol.md`, in the server→client section:

```markdown
### `chat_state`

Pushed on subscribe, pause, resume, seek, and window-boundary crossings. The
client binds its message input's disabled state to `enabled`.

| Field | Type | Notes |
|---|---|---|
| `enabled` | bool | Whether the user may send |
| `reason` | string | `ok`, `paused`, `outside_window`, `blocked`, `not_signed_in` |

### `chat_roster`

Sent once on successful subscribe.

| Field | Type | Notes |
|---|---|---|
| `buddies` | array | `{id, screen_name, display_name, avatar, online}`, ordered by the admin's sort field |

### `chat_presence`

Sent when a buddy signs on or off as the virtual clock advances. One frame per
changed buddy; most ticks emit none.

| Field | Type | Notes |
|---|---|---|
| `profile` | int | `chat_profiles.id` |
| `online` | bool | New state |
```

Note in the `subscribe` section that `chat` is the one channel requiring authentication, and that an anonymous subscribe is answered with `chat_state{enabled:false, reason:"not_signed_in"}` instead of being accepted.

- [ ] **Step 7: Commit**

```bash
git add packages/backend/internal/handler/ws.go packages/backend/cmd/server/main.go packages/backend/docs/websocket-protocol.md
git commit -m "feat(chat): wire the authenticated chat channel into the ws handler"
```

---

### Task 7: Dev harness

**Files:**
- Create: `packages/backend/internal/handler/chatdev.go`
- Create: `packages/backend/internal/handler/chatdev.html`
- Modify: `packages/backend/cmd/server/main.go`

**Interfaces:**
- Consumes: the wire frames from Task 6.
- Produces: `func handler.NewChatDevHandler(logger *slog.Logger) http.HandlerFunc`, served at `/chatdev` only when `CHAT_DEV_UI=1`.

- [ ] **Step 1: Write the page**

Create `packages/backend/internal/handler/chatdev.html`. It decodes MessagePack inline — the server→client wire is binary, so a naive `JSON.parse` shows nothing.

```html
<!doctype html>
<meta charset="utf-8">
<title>IM Buddies dev harness</title>
<style>
  body { font: 13px ui-monospace, monospace; margin: 0; display: grid;
         grid-template-columns: 220px 1fr; height: 100vh; }
  #side { border-right: 1px solid #ccc; padding: 8px; overflow: auto; }
  #main { display: flex; flex-direction: column; }
  #ctl { padding: 8px; border-bottom: 1px solid #ccc; }
  #log { flex: 1; overflow: auto; padding: 8px; white-space: pre-wrap; }
  .off { color: #999; }
  .bad { color: #b00; }
</style>
<div id="side"><b>Buddies</b><div id="roster">(not subscribed)</div></div>
<div id="main">
  <div id="ctl">
    <label>clock <input id="clock" size="24" value="2001-09-11T13:00:00Z"></label>
    <button id="seek">seek</button>
    <button id="pause">pause</button>
    <button id="resume">resume</button>
    <button id="sub">subscribe chat</button>
    <span id="state" class="bad">state: —</span>
  </div>
  <div id="log"></div>
</div>
<script>
// Minimal msgpack decoder. The server→client wire is binary, so JSON.parse
// shows nothing. Inlined rather than pulled from a CDN: no network dependency
// for a local dev tool, and no third-party script in the page. Extension types
// (time.Time) decode to null — the chat frames carry no time.Time fields, and
// the frames that do are filtered out of the log below.
function mp(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const td = new TextDecoder();
  let i = 0;
  const str = (n) => {
    const s = td.decode(new Uint8Array(buf.buffer, buf.byteOffset + i, n));
    i += n;
    return s;
  };
  const arr = (n) => { const a = []; for (let k = 0; k < n; k++) a.push(rd()); return a; };
  const map = (n) => { const o = {}; for (let k = 0; k < n; k++) { const key = rd(); o[key] = rd(); } return o; };
  function rd() {
    const b = dv.getUint8(i++);
    if (b <= 0x7f) return b;
    if (b >= 0xe0) return b - 256;
    if (b <= 0x8f) return map(b & 0x0f);
    if (b <= 0x9f) return arr(b & 0x0f);
    if (b <= 0xbf) return str(b & 0x1f);
    switch (b) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xca: { const v = dv.getFloat32(i); i += 4; return v; }
      case 0xcb: { const v = dv.getFloat64(i); i += 8; return v; }
      case 0xcc: return dv.getUint8(i++);
      case 0xcd: { const v = dv.getUint16(i); i += 2; return v; }
      case 0xce: { const v = dv.getUint32(i); i += 4; return v; }
      case 0xcf: { const v = Number(dv.getBigUint64(i)); i += 8; return v; }
      case 0xd0: return dv.getInt8(i++);
      case 0xd1: { const v = dv.getInt16(i); i += 2; return v; }
      case 0xd2: { const v = dv.getInt32(i); i += 4; return v; }
      case 0xd3: { const v = Number(dv.getBigInt64(i)); i += 8; return v; }
      case 0xd9: return str(dv.getUint8(i++));
      case 0xda: { const n = dv.getUint16(i); i += 2; return str(n); }
      case 0xdb: { const n = dv.getUint32(i); i += 4; return str(n); }
      case 0xdc: { const n = dv.getUint16(i); i += 2; return arr(n); }
      case 0xdd: { const n = dv.getUint32(i); i += 4; return arr(n); }
      case 0xde: { const n = dv.getUint16(i); i += 2; return map(n); }
      case 0xdf: { const n = dv.getUint32(i); i += 4; return map(n); }
      case 0xc4: { const n = dv.getUint8(i++); i += n; return null; }
      case 0xc5: { const n = dv.getUint16(i); i += 2 + n; return null; }
      case 0xc6: { const n = dv.getUint32(i); i += 4 + n; return null; }
      case 0xc7: { const n = dv.getUint8(i++); i += 1 + n; return null; }
      case 0xc8: { const n = dv.getUint16(i); i += 3 + n; return null; }
      case 0xc9: { const n = dv.getUint32(i); i += 5 + n; return null; }
      case 0xd4: i += 2; return null;
      case 0xd5: i += 3; return null;
      case 0xd6: i += 5; return null;
      case 0xd7: i += 9; return null;
      case 0xd8: i += 17; return null;
    }
    throw new Error("unsupported msgpack byte 0x" + b.toString(16));
  }
  return rd();
}

const url = new URL(location.href);
const ws = new WebSocket((url.protocol === "https:" ? "wss://" : "ws://") + url.host + "/stream");
ws.binaryType = "arraybuffer";

const log = (s) => {
  const el = document.getElementById("log");
  el.textContent += s + "\n";
  el.scrollTop = el.scrollHeight;
};
const send = (o) => { ws.send(JSON.stringify(o)); log("→ " + JSON.stringify(o)); };

ws.onopen = () => {
  log("connected");
  send({ type: "init", time: document.getElementById("clock").value });
};

ws.onmessage = (ev) => {
  const msg = mp(new Uint8Array(ev.data));
  if (msg.type === "chat_state") {
    const el = document.getElementById("state");
    el.textContent = "state: " + (msg.enabled ? "enabled" : "disabled (" + msg.reason + ")");
    el.className = msg.enabled ? "" : "bad";
  }
  if (msg.type === "chat_roster") {
    document.getElementById("roster").innerHTML = msg.buddies
      .map((b) => `<div class="${b.online ? "" : "off"}" data-id="${b.id}">${b.screen_name}</div>`)
      .join("");
  }
  if (msg.type === "chat_presence") {
    const row = document.querySelector(`#roster [data-id="${msg.profile}"]`);
    if (row) row.className = msg.online ? "" : "off";
  }
  if (msg.type !== "items" && msg.type !== "heartbeat_ack") {
    log("← " + JSON.stringify(msg));
  }
};

ws.onclose = () => log("disconnected");

document.getElementById("seek").onclick = () =>
  send({ type: "seek", time: document.getElementById("clock").value });
document.getElementById("pause").onclick = () => send({ type: "pause" });
document.getElementById("resume").onclick = () => send({ type: "resume" });
document.getElementById("sub").onclick = () => send({ type: "subscribe", channel: "chat" });
</script>
```

- [ ] **Step 2: Write the handler**

Create `packages/backend/internal/handler/chatdev.go`:

```go
package handler

import (
	_ "embed"
	"log/slog"
	"net/http"
)

//go:embed chatdev.html
var chatDevPage []byte

// NewChatDevHandler serves the IM Buddies dev harness. It exists because the
// Directus session cookie is httpOnly: a browser is the only client that can
// exercise the real auth path, so a CLI harness would test a different one.
// Registered only when CHAT_DEV_UI=1.
func NewChatDevHandler(logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		if _, err := w.Write(chatDevPage); err != nil {
			logger.Warn("chat dev page write failed", "error", err)
		}
	}
}
```

- [ ] **Step 3: Register it behind the flag**

In `packages/backend/cmd/server/main.go`, after the `/stream` registration:

```go
	if env("CHAT_DEV_UI", "") == "1" {
		mux.HandleFunc("/chatdev", handler.NewChatDevHandler(logger))
		logger.Warn("chat dev harness enabled at /chatdev — do not enable in production")
	}
```

- [ ] **Step 4: Build and verify end to end**

Run: `cd packages/backend && go build ./... && go vet ./... && go test ./...`
Expected: no output from build/vet; all tests pass.

Seed at least two `chat_profiles` rows in the Directus admin UI — one with no bounds, one with `online_from` set to `2001-09-11T15:00:00Z` — then start the streamer with `CHAT_DEV_UI=1` and open `http://localhost:8080/chatdev`.

Verify each of these by hand:

| Action | Expected |
|---|---|
| Load the page while signed out of Directus | `state: disabled (not_signed_in)` |
| Click **subscribe chat** while signed out | No roster; state stays `not_signed_in` |
| Sign in to Directus in another tab on the same domain, reload | Click subscribe → `state: enabled`, roster renders both buddies |
| At clock `13:00`, check the roster | The bounded buddy is greyed, the unbounded one is not |
| Seek to `15:30` | A `chat_presence` frame arrives and the bounded buddy un-greys |
| Click **pause** | `state: disabled (paused)` |
| Click **resume** | `state: enabled` |
| Seek to `2001-09-11T06:00:00Z` | `state: disabled (outside_window)` and every buddy greys out |

- [ ] **Step 5: Commit**

```bash
git add packages/backend/internal/handler/chatdev.go packages/backend/internal/handler/chatdev.html packages/backend/cmd/server/main.go
git commit -m "feat(chat): add browser dev harness behind CHAT_DEV_UI"
```

---

## What Plan A deliberately leaves out

So the next plan's implementer knows what is missing rather than assuming it broke:

- **`chat.Registry` beacon and phase resolution.** Task 2 loads profiles only; `chat_beacons` and `chat_phases` are seeded but never read. Plan C adds resolution.
- **`Session.ChatSend`, `chat_send`, `chat_message`, `chat_typing`, `chat_history`, `chat_error`.** No inbound path exists yet — the harness has no input box on purpose, and nothing can fail in a way that needs `chat_error`.
- **`chat.Guard`.** `chat_blocks` is seeded and `Gate.Blocked` is wired through `Available`, but nothing ever sets it. It is always `false` in Plan A.
- **Scheduled beats.** `chat_schedules` is seeded and unread. `horizonFor` intentionally returns `nil` for `chat`, which the existing `if h := ...; h != nil` guard already handles; Plan D adds the horizon field.
- **All generation.** No provider, no `Composer`, no API key, no `chat_messages` writes.

## Follow-on plans

- **Plan B — Transcript ingest** (`packages/tools/video-grabber`): SRT → `chat_transcript_segments`. Independent of A; can run in parallel.
- **Plan C — Knowledge + Composer**: three-tier retrieval and pure prompt assembly. Needs A's schema; degrades gracefully if B has not run.
- **Plan D — Providers + Generator + Guard + Store**: live replies, scheduled beats, moderation, logging.
