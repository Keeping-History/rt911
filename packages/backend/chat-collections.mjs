/**
 * chat-collections.mjs
 *
 * Shared schema definitions for the nine IM Buddies (`chat_*`) Directus
 * collections (see plans/2026-07-24-im-buddies-chatbot-design.md). Both
 * seed.mjs (full from-scratch bootstrap) and apply-chat-schema.mjs (narrow,
 * chat-only apply) import from here so the two never drift apart — a second
 * hand-copied set of these ~228 lines of field definitions would silently
 * diverge from whichever one was edited last.
 *
 * Nine collections: one settings singleton, four configuration tables, three
 * knowledge tiers (chat_knowledge + chat_transcript_segments; news_items is
 * tier 3 and already exists), and two per-user state tables.
 */

export const CHAT_COLLECTIONS = [
  {
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
  },
  {
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
      // NOT NULL so a missing sort cannot outrank an explicit one. Go reads this
      // column and re-sorts by it; a nullable column would put unset buddies first.
      { field: "sort", type: "integer", schema: { is_nullable: false, default_value: 0 }, meta: { hidden: true } },
    ],
  },
  {
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
  },
  {
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
      // NOT NULL for the same reason as chat_profiles.sort: Go reads this column
        // into a plain int, so a NULL fails the whole load, not one row.
        { field: "sort", type: "integer", schema: { is_nullable: false, default_value: 0 }, meta: { hidden: true } },
    ],
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
    collection: "chat_transcript_minutes",
    meta: {
      icon: "compress",
      note: "Tier 2, condensed — one extractive line per channel per minute, produced by video-grabber. The prompt reads this and falls back to chat_transcript_segments for any span not summarized yet.",
    },
    schema: {},
    fields: [
      { field: "id", type: "integer", schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true } },
      // channel/channel_slug/medium mirror chat_transcript_segments exactly: the
      // streamer filters tier 2 by the stations that reached a buddy's market,
      // and it applies the identical filter to whichever of the two tables it
      // read — a summary row missing its provenance could not be filtered.
      { field: "channel", type: "integer", schema: { is_nullable: true }, meta: { interface: "select-dropdown-m2o", width: "half" } },
      { field: "channel_slug", type: "string", schema: { is_nullable: true }, meta: { interface: "input", width: "half", note: "Used for radio, which has no tv_channels row" } },
      { field: "medium", type: "string", schema: { is_nullable: false, default_value: "tv" },
        meta: { interface: "select-dropdown", width: "half",
                options: { choices: ["tv", "radio"].map((v) => ({ text: v, value: v })) } } },
      { field: "minute", type: "timestamp", schema: { is_nullable: false }, meta: { interface: "datetime", width: "half", note: "Top of the minute this line covers" } },
      { field: "summary", type: "text", schema: { is_nullable: false }, meta: { interface: "input-multiline", width: "full", note: "Extractive: deduped and truncated broadcast words, never paraphrased" } },
      { field: "segment_count", type: "integer", schema: { is_nullable: true }, meta: { interface: "input", width: "half", note: "How many raw segments condensed into this line" } },
    ],
  },
  {
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
      // Soft delete, not a hard one: the transcript leaves the product while the
      // log survives. EVERY conversation read must filter on this being NULL —
      // history, replayed history, and the prior-contact check — or a cleared
      // conversation comes back through whichever path forgot.
      { field: "cleared_at", type: "timestamp", schema: { is_nullable: true },
        meta: { interface: "datetime", width: "full", readonly: true,
                note: "Set when the student cleared their chat history (IM Buddies > Edit > Settings > Delete Chat Data). Rows are retained; every conversation read skips those carrying this." } },
      { field: "kind", type: "string", schema: { is_nullable: false, default_value: "typed" },
        meta: { interface: "select-dropdown", width: "half",
                options: { choices: ["typed", "scheduled", "generated", "static", "stall"].map((v) => ({ text: v, value: v })) } } },
      { field: "moderation", type: "json", schema: { is_nullable: true }, meta: { interface: "input-code", width: "full", special: ["cast-json"] } },
      { field: "model", type: "string", schema: { is_nullable: true }, meta: { interface: "input", width: "half" } },
      { field: "tokens_in", type: "integer", schema: { is_nullable: true }, meta: { interface: "input", width: "half" } },
      { field: "tokens_out", type: "integer", schema: { is_nullable: true }, meta: { interface: "input", width: "half" } },
      { field: "cached_in", type: "integer", schema: { is_nullable: true },
        meta: { interface: "input", width: "half",
                note: "Prompt tokens served from cache, billed at ~0.1x. DISJOINT from tokens_in, which counts only the uncached remainder — the full prompt is tokens_in + cache_write_in + cached_in. Zero across a whole conversation means prompt caching is not working." } },
      { field: "cache_write_in", type: "integer", schema: { is_nullable: true },
        meta: { interface: "input", width: "half",
                note: "Prompt tokens written to cache, billed at ~1.25x. Watch for this staying high while cached_in stays zero: that is the write premium being paid every turn for a prefix nothing ever reads back — the exact failure this feature shipped with, undetected, for months." } },
    ],
  },
  {
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
  },
];

// The seven chat-specific indexes that used to ride inside seed.mjs's shared
// createStreamerIndexes() psql(...) call. Kept as a plain SQL string (not
// per-table functions) because psql() takes a raw script either way and the
// callers just need to hand it off — seed.mjs runs this via its own psql(),
// apply-chat-schema.mjs via its own PSQL_URL-gated runner.
export const CHAT_INDEX_SQL = `
    CREATE INDEX IF NOT EXISTS idx_chat_knowledge_public   ON chat_knowledge (public_at);
    CREATE INDEX IF NOT EXISTS idx_chat_transcript_start   ON chat_transcript_segments (start_date);
    -- LoadBroadcastMinutes runs on the session goroutine for every message, and
    -- it is a range scan on minute plus a channel/slug filter. Leading with
    -- minute matches that shape (the range is the selective part — ten minutes
    -- out of nine days); without it this is a seq scan of the whole table on
    -- the hot path, which is the same mistake idx_news_items_fts documents.
    CREATE INDEX IF NOT EXISTS idx_chat_minutes_minute    ON chat_transcript_minutes (minute, medium);
    CREATE INDEX IF NOT EXISTS idx_chat_transcript_fts     ON chat_transcript_segments USING GIN (to_tsvector('english', text));
    CREATE INDEX IF NOT EXISTS idx_chat_messages_user_conv ON chat_messages (( "user" ), profile, virtual_time);
    CREATE INDEX IF NOT EXISTS idx_chat_blocks_user        ON chat_blocks (( "user" ), scope);
    CREATE INDEX IF NOT EXISTS idx_chat_schedules_profile  ON chat_schedules (profile, active);
    -- news_items is not a chat collection, but tier-3 retrieval searches it and
    -- the expression must match SearchTimeline's exactly or the planner ignores
    -- the index. Without it a query matching nothing scans all 7k rows building
    -- a tsvector per row: measured at 1954ms, against 0.139ms with it. Tier 3
    -- fires precisely when tiers 1 and 2 miss, which is when a no-match is most
    -- likely, and it runs on the session goroutine.
    CREATE INDEX IF NOT EXISTS idx_news_items_fts ON news_items USING GIN (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,'')));
    CREATE INDEX IF NOT EXISTS idx_chat_phases_profile     ON chat_phases (profile, sort);
`;
