/**
 * import-usenet.mjs
 *
 * Imports usenet NDJSON files (out.*.json) into Directus media_items.
 *
 * Each file is newline-delimited JSON; each record has:
 *   { source_file, date_iso, headers: { from, subject, date, newsgroups, message-id, … }, body: { text_plain, … } }
 *
 * Records are inserted as format="usenet" rows in media_items.
 * The newsgroup name (first value from headers.newsgroups) becomes the source slug.
 *
 * Usage:
 *   node import-usenet.mjs [glob-pattern]
 *
 * Environment (falls back to seed.mjs defaults):
 *   DIRECTUS_URL, ADMIN_EMAIL, ADMIN_PASSWORD, DB_USER, DB_DATABASE, PSQL_URL
 *   USENET_DIR   – directory containing out.*.json files (default: /Volumes/Other Media)
 *   START_FILE   – skip files before this name, e.g. "out.05000.json" (for resuming)
 *   DRY_RUN      – set to "1" to parse and log without writing to the DB
 */

import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DIRECTUS_URL   = process.env.DIRECTUS_URL   ?? "http://localhost:8055";
const ADMIN_EMAIL    = process.env.ADMIN_EMAIL    ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "changeme";
const DB_USER        = process.env.DB_USER        ?? "directus";
const DB_DATABASE    = process.env.DB_DATABASE    ?? "directus";
const USENET_DIR     = process.env.USENET_DIR     ?? "/Volumes/Other Media";
const START_FILE     = process.env.START_FILE     ?? "";
const DRY_RUN        = process.env.DRY_RUN === "1";

const BATCH_SIZE     = 500;   // rows per INSERT
const FORMAT         = "usenet";

// ---------------------------------------------------------------------------
// Shared helpers (same pattern as seed.mjs)
// ---------------------------------------------------------------------------

async function getToken() {
  const MAX_ATTEMPTS = 20;
  const RETRY_DELAY_MS = 10_000;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(`${DIRECTUS_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    if (res.ok) {
      const { data } = await res.json();
      return data.access_token;
    }
    const body = await res.text();
    if (res.status === 503 && attempt < MAX_ATTEMPTS) {
      console.log(`Directus not ready (attempt ${attempt}/${MAX_ATTEMPTS}), retrying…`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      continue;
    }
    throw new Error(`Login failed: ${body}`);
  }
}

async function api(token, method, path, body) {
  const res = await fetch(`${DIRECTUS_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function psql(sql) {
  if (DRY_RUN) return;
  const psqlUrl = process.env.PSQL_URL;
  if (psqlUrl) {
    const r = spawnSync("psql", [psqlUrl, "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`psql failed:\n${r.stderr || r.stdout}`);
    return;
  }
  const r = spawnSync(
    "docker",
    ["compose", "exec", "-T", "rt911-db", "psql", "-U", DB_USER, "-d", DB_DATABASE, "-v", "ON_ERROR_STOP=1"],
    { input: sql, cwd: __dirname, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`psql failed:\n${r.stderr || r.stdout}`);
}

function sqlVal(v) {
  if (v === null || v === undefined || v === "") return "NULL";
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// Date parsing
// ---------------------------------------------------------------------------

/**
 * Best-effort conversion of a usenet Date header to a Postgres-compatible
 * "YYYY-MM-DD HH:MM:SS" string (UTC). Returns null on failure.
 */
function parseUsenetDate(dateIso, headerDate) {
  // Prefer pre-parsed ISO value when present
  if (dateIso) {
    const d = new Date(dateIso);
    if (!isNaN(d.getTime())) return toUtcTimestamp(d);
  }

  if (!headerDate) return null;

  // YYYY/MM/DD (Google Groups archive format)
  const slash = headerDate.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (slash) return `${slash[1]}-${slash[2]}-${slash[3]} 00:00:00`;

  // RFC 2822 and common variants — delegate to Date.parse
  const d = new Date(headerDate);
  if (!isNaN(d.getTime())) return toUtcTimestamp(d);

  return null;
}

function toUtcTimestamp(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// ---------------------------------------------------------------------------
// Source slug resolution
// ---------------------------------------------------------------------------

function extractNewsgroup(headers, sourceFile) {
  const ng = headers["newsgroups"];
  if (ng) {
    // May be comma-separated; take the first entry
    const first = String(ng).split(",")[0].trim();
    if (first) return first.slice(0, 255);
  }
  // Fall back to the mbox filename (strip path and extension)
  const m = String(sourceFile ?? "").match(/([^/\\]+)\.mbox/);
  return m ? m[1].slice(0, 255) : "usenet";
}

// ---------------------------------------------------------------------------
// Schema setup — add "usenet" to the format dropdown if missing
// ---------------------------------------------------------------------------

async function ensureUsenetFormat(token) {
  const fields = await api(token, "GET", "/fields/media_items");
  const formatField = fields.data.find((f) => f.field === "format");
  if (!formatField) {
    console.warn("Warning: media_items.format field not found — skipping dropdown update.");
    return;
  }
  const choices = formatField.meta?.options?.choices ?? [];
  if (choices.some((c) => c.value === FORMAT)) {
    console.log(`Format "${FORMAT}" already in dropdown, skipping.`);
    return;
  }
  console.log(`Adding "${FORMAT}" to media_items.format dropdown…`);
  await api(token, "PATCH", "/fields/media_items/format", {
    meta: {
      ...formatField.meta,
      options: {
        ...formatField.meta?.options,
        choices: [...choices, { text: FORMAT.toUpperCase(), value: FORMAT }],
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Source cache — avoid per-record API calls
// ---------------------------------------------------------------------------

async function loadSourceMap(token) {
  const all = await api(token, "GET", "/items/sources?limit=-1&fields=id,slug");
  return new Map(all.data.map((s) => [s.slug, s.id]));
}

async function upsertSource(token, sourceMap, slug) {
  if (sourceMap.has(slug)) return sourceMap.get(slug);
  if (DRY_RUN) { sourceMap.set(slug, 0); return 0; }
  const created = await api(token, "POST", "/items/sources", [{ name: slug, slug }]);
  const id = created.data[0].id;
  sourceMap.set(slug, id);
  return id;
}

// ---------------------------------------------------------------------------
// Record transformation
// ---------------------------------------------------------------------------

function transformRecord(r, sourceId, sort) {
  const h = r.headers ?? {};
  const subject = (h.subject ?? "").trim().slice(0, 500) || "(no subject)";
  const from    = (h.from    ?? "").trim().slice(0, 500);
  const msgId   = (h["message-id"] ?? "").trim();
  const startDate = parseUsenetDate(r.date_iso, h.date);

  // Flatten body to plain text
  let bodyText = null;
  if (r.body) {
    const parts = r.body.text_plain ?? r.body.text_html ?? [];
    const joined = parts.filter(Boolean).join("\n\n").trim();
    if (joined) bodyText = joined;
  }

  // Store structured metadata in the content field as JSON
  const content = JSON.stringify({
    message_id:  msgId,
    from:        from,
    newsgroups:  h.newsgroups ?? "",
    source_file: r.source_file ?? "",
    body:        bodyText ?? "",
  });

  return {
    title:         subject,
    full_title:    from,
    source:        sourceId,
    start_date:    startDate,
    end_date:      startDate,
    calc_duration: 0,
    timezone:      null,
    url:           msgId || null,
    format:        FORMAT,
    approved:      1,
    mute:          0,
    volume:        1,
    jump:          0,
    trim:          0,
    image:         null,
    image_caption: null,
    content,
    sort,
  };
}

// ---------------------------------------------------------------------------
// NDJSON streaming reader
// ---------------------------------------------------------------------------

function readNdjsonFile(filePath) {
  return new Promise((resolve, reject) => {
    const records = [];
    const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try { records.push(JSON.parse(trimmed)); } catch { /* skip malformed lines */ }
    });
    rl.on("close", () => resolve(records));
    rl.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Batch insert
// ---------------------------------------------------------------------------

const COLS = `title,full_title,source,start_date,end_date,calc_duration,timezone,url,format,approved,mute,volume,jump,"trim",image,image_caption,content,sort`;

function insertBatch(rows) {
  const values = rows.map((r) => `(${[
    sqlVal(r.title),
    sqlVal(r.full_title),
    sqlVal(r.source),
    sqlVal(r.start_date),
    sqlVal(r.end_date),
    sqlVal(r.calc_duration),
    sqlVal(r.timezone),
    sqlVal(r.url),
    sqlVal(r.format),
    sqlVal(r.approved),
    sqlVal(r.mute),
    sqlVal(r.volume),
    sqlVal(r.jump),
    sqlVal(r.trim),
    sqlVal(r.image),
    sqlVal(r.image_caption),
    sqlVal(r.content),
    sqlVal(r.sort),
  ].join(",")})`).join(",\n");
  psql(`INSERT INTO media_items (${COLS}) VALUES\n${values};\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const token = await getToken();
console.log("Authenticated.");

await ensureUsenetFormat(token);

// Get current max sort so we append after existing records
const sortRes = await api(token, "GET", "/items/media_items?limit=1&sort[]=-sort&fields[]=sort");
let nextSort = (sortRes.data?.[0]?.sort ?? 0) + 1;

const sourceMap = await loadSourceMap(token);
console.log(`Loaded ${sourceMap.size} existing sources.`);

// List and sort all out.*.json files
const allFiles = (await readdir(USENET_DIR))
  .filter((f) => /^out\.\d+\.json$/.test(f))
  .sort();

const files = START_FILE
  ? allFiles.filter((f) => f >= START_FILE)
  : allFiles;

console.log(`Found ${allFiles.length} files total; importing ${files.length} starting from "${files[0] ?? "none"}".`);

if (DRY_RUN) console.log("DRY RUN — no DB writes will occur.");

let totalInserted = 0;
let totalSkipped  = 0;

for (let fi = 0; fi < files.length; fi++) {
  const fileName = files[fi];
  const filePath = join(USENET_DIR, fileName);
  process.stdout.write(`[${fi + 1}/${files.length}] ${fileName} … `);

  const records = await readNdjsonFile(filePath);

  // Collect pending rows, resolving sources as needed
  const batch = [];
  let fileInserted = 0;
  let fileSkipped  = 0;

  for (const r of records) {
    const slug     = extractNewsgroup(r.headers ?? {}, r.source_file);
    const sourceId = await upsertSource(token, sourceMap, slug);
    const row      = transformRecord(r, sourceId, nextSort);

    if (!row.start_date) { fileSkipped++; continue; }

    batch.push(row);
    nextSort++;
    fileInserted++;

    if (batch.length >= BATCH_SIZE) {
      insertBatch(batch.splice(0, BATCH_SIZE));
    }
  }
  if (batch.length > 0) insertBatch(batch);

  totalInserted += fileInserted;
  totalSkipped  += fileSkipped;
  console.log(`${fileInserted} inserted, ${fileSkipped} skipped (no date)`);
}

console.log(`\nDone. Total inserted: ${totalInserted}, skipped: ${totalSkipped}`);
console.log(`Next sort value: ${nextSort}`);
