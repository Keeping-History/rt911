---
status: completed
approved_at: "2026-06-29T23:47:31.623Z"
updated: "2026-06-30T02:11:52.730Z"
started_at: "2026-06-29T23:48:11.211Z"
completed_at: "2026-06-30T02:11:52.730Z"
---
# Feedback App — Design Spec

**Date:** 2026-06-29
**Status:** Approved

---

## Overview

A ClassicyApp called "Feedback" that lets users submit name, email, optional GitHub username, title, description, image attachments, and an optional DOM screenshot. On submit, the Go streamer backend uploads images to Wasabi and creates a GitHub issue in `Keeping-History/rt911`. The OpenReplay session URL is appended to the issue body automatically.

---

## Architecture

```
Frontend (Vite SPA)
  └─ POST /feedback  (multipart/form-data)
        │
        ▼
Go Streamer (/feedback handler)
  ├─ 1. Parse form fields + image files
  ├─ 2. Upload images → Wasabi (feedback/{uuid}/{filename})
  │       → public URL via files.911realtime.org/feedback/...
  ├─ 3. Create GitHub Issue (Issues API, Keeping-History/rt911)
  │       body = formatted Markdown with fields + image links + OpenReplay URL
  └─ 4. Return {"ok": true, "issueUrl": "..."}
```

**External dependencies:**
- `html2canvas-pro` — DOM screenshot capture (frontend, new package — use this fork, not the unmaintained `html2canvas`)
- GitHub Issues REST API — issue creation (backend, HTTP call)
- Wasabi S3 — image storage (backend, `github.com/minio/minio-go/v7` — new dependency, no S3 client currently exists)

### Research Enhancement

- **Blocker — handler approval:** `packages/backend/CLAUDE.md` requires explicit Boss approval before adding any HTTP endpoint beyond `/stream` and `/health`. Resolve before writing any backend code.
- **Handler location:** Must live at `internal/handler/feedback.go` (not `packages/backend/feedback.go`). Registration is a single `mux.HandleFunc` line in `main.go` — no business logic in `main.go`. This matches the `NewWSHandler` pattern exactly.
- **S3 client is net-new:** `go.mod` has no AWS SDK or MinIO client. Add `github.com/minio/minio-go/v7` (lighter than `aws-sdk-go-v2`; Wasabi is an explicitly documented target).
- **Frontend URL in production:** The SPA (nginx) and streamer are on different origins — relative `/feedback` will 404 against nginx. A new `VITE_FEEDBACK_URL` build-time env var is required. Add it to `packages/frontend/Dockerfile` (`ARG`/`ENV`), the `build-args` block in `.github/workflows/build.yml`, and `packages/frontend/.env.example`. The frontend reads `import.meta.env.VITE_FEEDBACK_URL ?? 'http://localhost:8080'`.
- **Ref:** cross-repo agent (packages/backend/go.mod, packages/backend/CLAUDE.md, packages/frontend/nginx.conf, .github/workflows/build.yml)

---

## File Structure

### Frontend

```
packages/frontend/src/Applications/Feedback/
├── Feedback.tsx           # ClassicyApp shell; owns view state (form | submitting | success | error)
├── FeedbackForm.tsx       # Renders all form fields, attachment list, screenshot button
├── FeedbackSuccess.tsx    # Thank-you screen with issue link and "Send Another" button
├── useFeedback.ts         # html2canvas capture, multipart POST, state machine
└── Feedback.module.scss   # Styles scoped to the app
```

`Feedback` is added to `packages/frontend/src/app.tsx` alongside the other apps. No other registration needed.

`packages/frontend/src/openreplay.ts` gets two new exports:
```ts
export function getSessionURL(withCurrentTime = false): string | undefined
export function getSessionID(): string | null | undefined
```

### Backend

```
packages/backend/internal/handler/
├── feedback.go            # POST /feedback handler + Wasabi upload + GitHub issue creation
└── feedback_test.go       # Unit tests for issue body formatting and handler behaviour
```

---

## Frontend — Component Design

### `Feedback.tsx`

- Renders `<ClassicyApp id="Feedback.app" name="Feedback" ...>`
- Single `<ClassicyWindow>` — `initialSize={[480, 0]}` (auto-height), `initialPosition={[250, 150]}`, not resizable, not zoomable
- File menu: one item — Quit (via `quitMenuItemHelper`)
- Owns `view: "form" | "success"` state and the submit callback
- Passes `onSubmit` down to `FeedbackForm`; passes `issueUrl` and `onReset` to `FeedbackSuccess`

### Research Enhancement

- **App icon:** No `feedback` or `bug` key in `ClassicyIcons`. Best match for the Mac OS 9 aesthetic: `ClassicyIcons.system.bomb` (classic crash-dialog icon). Conservative fallback: `ClassicyIcons.system.warn`. Usage: `const appIcon = ClassicyIcons.system.bomb as string;`
- **app.tsx registration:** Import and drop `<Feedback />` as a bare child of `<ClassicyDesktop>` — the pattern used by every other app (app.tsx lines 65–75). No props.
- **initialPosition:** `[250, 150]` matches the convention for small secondary windows — Controls.tsx:141 settings dialog and Browser.tsx:376 settings dialog both use this value.
- **Ref:** pattern agent (app.tsx:65-75, Controls.tsx:141, Browser.tsx:376)

### `FeedbackForm.tsx`

Fields (all controlled inputs):

| Field | Type | Required |
|---|---|---|
| Name | `<input type="text">` | Yes |
| Email | `<input type="email">` | Yes |
| GitHub username | `<input type="text">` | No — labeled "(optional)" |
| Title | `<input type="text">` | Yes |
| Description | `<textarea rows={5}>` | Yes |

Attachment section:
- `<input type="file" accept="image/*" multiple>` — triggers append to attachment list
- Selected files render as small thumbnail previews in a horizontal row, each with an ✕ remove button
- "Capture Screenshot" button: calls `useFeedback`'s `captureScreenshot()`, prepends the resulting PNG blob to the attachment list as `screenshot.png`

Submit section:
- "Send Feedback" button — disabled while `submitting === true`
- Shows "Sending…" label during in-flight POST
- Inline error message below the button on failure (form stays filled — no data loss)

### Research Enhancement

- **File validation (frontend — UX only, backend is authoritative):** Max 5 files, 5 MB per file, allowed types `image/jpeg|png|gif|webp`, `application/pdf`, `text/plain`. Show an inline error before the user submits.
- **`accept` attribute:** Tighten `<input type="file" accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain">` to match the backend allowlist.
- **Ref:** best-practice agent

### `FeedbackSuccess.tsx`

- Thank-you message
- Clickable link to the created GitHub issue (`issueUrl`)
- "Send Another Feedback" button that calls `onReset()` to return to a blank form

### `useFeedback.ts`

```ts
interface FeedbackState {
  submitting: boolean;
  error: string | null;
}

function useFeedback(): {
  state: FeedbackState;
  captureScreenshot: () => Promise<File>;
  submit: (fields: FeedbackFields, attachments: File[]) => Promise<string>; // returns issueUrl
}
```

`captureScreenshot`:
1. Calls `html2canvas(document.getElementById('root')!)` from `html2canvas-pro`
2. Pass `useCORS: true` and `ignoreElements` to skip cross-origin iframes (Browser app, BlueBox)
3. Converts canvas to a `Blob` via `canvas.toBlob('image/png')`
4. Returns a `File` named `screenshot.png`

`submit`:
1. Calls `getSessionURL()` from `openreplay.ts`
2. Builds a `FormData` with all text fields + session URL + attachment files
3. POSTs to `` `${import.meta.env.VITE_FEEDBACK_URL ?? 'http://localhost:8080'}/feedback` ``
4. On 200: returns `issueUrl` from response JSON
5. On error: throws with message from response body

### Research Enhancement

- **Use `html2canvas-pro`, not `html2canvas`:** Original is unmaintained since 2022. `html2canvas-pro@^2.2.0` is a drop-in replacement (`import html2canvas from 'html2canvas-pro'`). Cross-origin iframes (Browser/BlueBox) must be skipped with `ignoreElements` — any other approach produces a tainted canvas and `toDataURL()` will throw. Do **not** use `allowTaint: true`.
  ```ts
  const canvas = await html2canvas(document.getElementById('root')!, {
      useCORS: true,
      ignoreElements: (el) => {
          if (el.tagName !== 'IFRAME') return false;
          try { return new URL((el as HTMLIFrameElement).src).origin !== window.location.origin; }
          catch { return true; }
      },
  });
  ```
- **`getSessionURL` API correction:** The actual tracker signature is `getSessionURL(options?: { withCurrentTime?: boolean })` — an options object, not a positional boolean. Wrapper:
  ```ts
  export function getSessionURL(withCurrentTime = false): string | undefined {
      return tracker?.getSessionURL({ withCurrentTime });
  }
  export function getSessionID(): string | null | undefined {
      return tracker?.getSessionID();
  }
  ```
  `getSessionToken()` is a distinct method (raw token string) — do not conflate with the URL.
- **POST URL:** Use `VITE_FEEDBACK_URL` env var, not a relative path. Relative paths hit nginx in production (which only serves static files).
- **Ref:** framework agent (node_modules/@openreplay/tracker/dist/types/main/index.d.ts, html2canvas-pro npm, vite.dev/config/server-options)

---

## Backend — Handler Design (`internal/handler/feedback.go`)

**Route:** `POST /feedback` registered on the existing Go HTTP mux in `main.go`.

**Constructor (matching `NewWSHandler` pattern in `internal/handler/ws.go:70`):**
```go
func NewFeedbackHandler(githubAPIURL, s3Endpoint, s3Bucket, githubToken string, logger *slog.Logger) http.HandlerFunc
```

**Request parsing:**
- `http.MaxBytesReader(w, r.Body, 26<<20)` — enforced **before** `ParseMultipartForm`
- `r.ParseMultipartForm(4 << 20)` — 4 MB in-memory, overflow to temp files
- Text fields: `name`, `email`, `github` (optional), `title`, `description`, `sessionUrl` (optional)
- Files: all parts with key `attachments[]`, max 5 files, max 5 MB each

**Validation:**
- `name`, `email`, `title`, `description` must be non-empty — returns HTTP 400 with `{"error": "..."}` if missing
- Per-file: reject if `fh.Size > 5<<20`; verify MIME via `http.DetectContentType` (magic bytes) — never trust client-supplied Content-Type

**Image upload:**
- Concurrent via `errgroup.WithContext` with `g.SetLimit(5)`; per-upload timeout 30s; batch timeout 2 minutes
- Key pattern: `feedback/{uuid}/{originalFilename}`
- Public URL: `https://files.911realtime.org/feedback/{uuid}/{originalFilename}`

**GitHub issue body (Markdown template):**

```markdown
## Feedback

**Type:** Bug Report

**Description:**
{description}

---

## Reporter

| Field | Value |
|---|---|
| Name | {name} |
| Email | {email} |
| GitHub | @{github} |

*(GitHub row omitted when username is blank)*

---

## Session

| Field | Value |
|---|---|
| Session URL | {sessionUrl} |

*(Session section omitted entirely when sessionUrl is blank)*

---

## Attachments

- [{filename}]({wasabiUrl})

*(Attachments section omitted when no files are uploaded)*
```

**GitHub API call:**
- `POST {githubAPIURL}/repos/Keeping-History/rt911/issues`
- Auth: `Authorization: Bearer {GITHUB_FEEDBACK_TOKEN}`
- Body: `{"title": "[Feedback] {title}", "body": "...", "labels": ["feedback"]}`
- `feedback` label created at startup: best-effort only — 422 = already exists (not an error); any other error = `slog.Warn` and continue. GitHub silently drops unknown labels at issue-creation time, so a missing label is cosmetic, not a blocking failure.

**Response:**
- `200 {"ok": true, "issueUrl": "https://github.com/Keeping-History/rt911/issues/NNN"}`
- `400 {"error": "missing required field: name"}` etc.
- `413 {"error": "request too large"}`
- `429 {"error": "rate limit exceeded"}`
- `502 {"error": "github api error: ..."}` if the GitHub call fails

### Research Enhancement

- **Rate limiting — HIGH:** Every POST triggers S3 uploads + a GitHub API call (external side effects, quota cost). Add per-IP rate limiting middleware: 5 req/min, burst 3, using `golang.org/x/time/rate` with a per-IP limiter map and a 5-minute cleanup goroutine. Use `r.RemoteAddr` — do not trust `X-Forwarded-For` unless behind a controlled proxy. Alternative: `github.com/go-chi/httprate` as a drop-in.
- **CSRF — MEDIUM:** `multipart/form-data` doesn't trigger a preflight, so cross-site forms can POST without CORS blocking. Defence: check `Sec-Fetch-Site` header — reject if value is `cross-site`. Fallback for legacy browsers: check `Origin` header against an allowlist. Do not reject requests where `Sec-Fetch-*` is absent entirely (old browsers omit these headers).
- **File limits enforcement order:** `http.MaxBytesReader` must run **before** `r.ParseMultipartForm`. If ParseMultipartForm runs first, Go buffers the entire body before rejection. Use `http.DetectContentType` (magic bytes) for MIME verification — client-supplied type is untrustworthy.
- **Concurrent uploads:** `errgroup.WithContext` with `g.SetLimit(5)` and 30s per-upload timeout. First error cancels all in-flight uploads via context cancellation. Consider an S3 lifecycle rule to expire `feedback/` objects after 90 days to handle orphaned partial uploads.
- **GitHub token — HIGH:** Use a fine-grained PAT scoped to `Issues: Read+Write` + `Metadata: Read-only` on `Keeping-History/rt911` only (90-day expiry) for initial implementation. GitHub App with `github.com/bradleyfalzon/ghinstallation/v2` is the production path — 8-hour auto-rotating tokens, not tied to a human account, 15k req/hr quota. Plan migration before first PAT rotation.
- **Ref:** best-practice agent; pattern agent (internal/handler/ws.go:70)

---

## Infrastructure Changes

### k8s Secret

Add `GITHUB_FEEDBACK_TOKEN` to the streamer deployment's env. The token is a GitHub fine-grained PAT scoped to:
- Repository: `Keeping-History/rt911`
- Permissions: `Issues: Read and Write`

### nginx-s3-gateway (infra GitOps repo)

Add `/feedback/*` to the Traefik Ingress path allow-list so uploaded images are publicly served at `files.911realtime.org/feedback/...`.

### Vite dev proxy (`vite.config.ts`)

`vite.config.ts` currently has no `server.proxy` block — only `server.headers`. Add inside the existing `server` object:

```ts
proxy: {
    "/feedback": {
        target: "http://localhost:8080",
        changeOrigin: true, // rewrites Host header; required for Go's net/http mux
    },
},
```

### New env var: `VITE_FEEDBACK_URL`

Add to:
1. `packages/frontend/Dockerfile` — `ARG VITE_FEEDBACK_URL` + `ENV VITE_FEEDBACK_URL=$VITE_FEEDBACK_URL`
2. `.github/workflows/build.yml` — `build-args: VITE_FEEDBACK_URL=https://stream-beta.911realtime.org`
3. `packages/frontend/.env.example` — `VITE_FEEDBACK_URL=http://localhost:8080`

### Research Enhancement

- **Vite proxy note:** The proxy will return a 404 from the Go server until the `/feedback` handler is registered in `main.go`. The proxy config and the handler registration must land together.
- **`changeOrigin: true` is required:** Without it, the `Host` header remains `localhost:5173` and Go's `net/http` mux may reject it.
- **Ref:** framework agent (vite.config.ts, main.go)

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| Required field missing | Frontend: button stays disabled. Backend: 400 with field name. |
| Wasabi upload fails | Backend: 502, issue is not created, error returned to frontend |
| GitHub API fails | Backend: 502, error message surfaced inline in the form |
| Network error (fetch) | `useFeedback` catches, sets `error` state, form stays filled |
| OpenReplay not active | `getSessionURL()` returns `undefined`; session section omitted from issue |
| Too many files / file too large | Frontend: inline validation before submit. Backend: 400 |
| Request body exceeds 26 MB | Backend: 413 from `http.MaxBytesReader` |
| Rate limit exceeded | Backend: 429 |
| Cross-origin iframe in screenshot | `ignoreElements` skips it; rest of page captured normally |

---

## Testing

**Frontend:**
- `useFeedback.test.ts` — mock `fetch`, assert FormData contents, assert state transitions (idle → submitting → success/error)
- `FeedbackForm.test.tsx` — assert required field validation disables submit, assert thumbnail renders after file selection, assert screenshot button calls capture

**Backend:**
- `feedback_test.go`:
  - **Issue body formatting:** extract as a pure `formatIssueBody(fields, attachments) string` function — table-driven tests with no server or mock (all fields; GitHub blank; sessionUrl blank; no attachments; one attachment; multiple attachments)
  - **HTTP handler:** `httptest.NewServer` as a fake GitHub API (passed via constructor's `githubAPIURL` param); `httptest.NewServer` as a fake S3 endpoint — matching the pattern in `internal/handler/ws_test.go:29-38`. No interface mocks, no testify/mock.
  - **Validation:** missing required field → 400; too many files → 400; oversized body → 413

### Research Enhancement

- **Constructor injection (no interfaces):** The codebase has zero interface types in `internal/`. Follow `NewWSHandler` exactly: accept `githubAPIURL` and `s3Endpoint` as string params. In tests, point them at local `httptest.Server` instances. See `internal/handler/ws_test.go:29-38` (`newTestServer` helper) as the direct model to copy.
- **Pure function split:** Separate `formatIssueBody` from the HTTP handler so body-format tests need no server at all. This is the natural test boundary.
- **Ref:** pattern agent (internal/handler/ws.go:70, internal/handler/ws_test.go:29-38, internal/cache/redis_test.go:14-25)

---

## Enrichment Summary

**Deepened:** 2026-06-29
**Gaps found:** 15
**Agents used:** spec-flow-analyzer, framework-docs-researcher, repo-research-researcher, corporate-knowledge-researcher, best-practices-researcher
**Second opinion:** timed out (OpenRouter GPT-5.4, 300s)
**Confidence:** N/A (no synthesizer needed — all agent findings consistent)

### Key Discoveries

- "Existing Wasabi S3 client" does not exist — `go.mod` has no S3 library. Add `github.com/minio/minio-go/v7`.
- Handler must live at `internal/handler/feedback.go`, not the repo root. Requires explicit Boss approval per `CLAUDE.md` before any endpoint is added.
- Relative `/feedback` path will 404 in production — nginx serves only static files, no `proxy_pass`. A new `VITE_FEEDBACK_URL` build-arg is mandatory.
- `html2canvas` is unmaintained since 2022 — use `html2canvas-pro`. Cross-origin iframes must be excluded via `ignoreElements` to avoid a tainted-canvas security error.
- `getSessionURL` takes `{ withCurrentTime?: boolean }` (options object), not a positional boolean — the plan's proposed wrapper signature was wrong.
- The plan had no concrete issue body Markdown template — added above with full conditional logic for all optional fields.
- Fine-grained PAT (not classic) required for GitHub; GitHub App is the production-grade path.

### New Risks Identified

- **CSRF / DoS — MEDIUM/HIGH:** Unauthenticated endpoint with S3 + GitHub side effects per request. Mitigate with `Sec-Fetch-Site` CSRF check and per-IP rate limiting (5 req/min). Not addressed in original plan.
- **VITE_FEEDBACK_URL missing from CI — HIGH:** Without this env var, production fetches hit nginx and 404. Must be added to Dockerfile, `build.yml`, and `.env.example` before any deployment.
- **CLAUDE.md endpoint approval — BLOCKER:** Cannot add `/feedback` without Boss's explicit sign-off. Must resolve before implementation starts.
- **PAT rotation — MEDIUM:** 90-day fine-grained PAT will expire. Plan GitHub App migration or calendar the rotation before first expiry.
