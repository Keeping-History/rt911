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
- `html2canvas` — DOM screenshot capture (frontend, new package)
- GitHub Issues REST API — issue creation (backend, HTTP call)
- Wasabi S3 — image storage (backend, existing S3 client)

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
packages/backend/
├── feedback.go            # POST /feedback handler + Wasabi upload + GitHub issue creation
└── feedback_test.go       # Unit tests for issue body formatting and handler behaviour
```

---

## Frontend — Component Design

### `Feedback.tsx`

- Renders `<ClassicyApp id="Feedback.app" name="Feedback" ...>`
- Single `<ClassicyWindow>` — `initialSize={[480, 0]}` (auto-height), centered, not resizable, not zoomable
- File menu: one item — Quit (via `quitMenuItemHelper`)
- Owns `view: "form" | "success"` state and the submit callback
- Passes `onSubmit` down to `FeedbackForm`; passes `issueUrl` and `onReset` to `FeedbackSuccess`

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
1. Calls `html2canvas(document.getElementById('root')!)`
2. Converts canvas to a `Blob` via `canvas.toBlob('image/png')`
3. Returns a `File` named `screenshot.png`

`submit`:
1. Calls `getSessionURL()` from `openreplay.ts`
2. Builds a `FormData` with all text fields + session URL + attachment files
3. POSTs to `/feedback` (same-origin relative path — proxied by nginx to the streamer in prod, hit directly in dev via Vite proxy config)
4. On 200: returns `issueUrl` from response JSON
5. On error: throws with message from response body

---

## Backend — Handler Design (`feedback.go`)

**Route:** `POST /feedback` registered on the existing Go HTTP mux.

**Request parsing:**
- `r.ParseMultipartForm(32 << 20)` — 32 MB memory limit
- Text fields: `name`, `email`, `github` (optional), `title`, `description`, `sessionUrl` (optional)
- Files: all parts with key `attachments[]`

**Validation:**
- `name`, `email`, `title`, `description` must be non-empty — returns HTTP 400 with `{"error": "..."}` if missing

**Image upload:**
- For each attachment file: upload to Wasabi using the existing S3 client
- Key pattern: `feedback/{uuid}/{originalFilename}`
- Public URL: `https://files.911realtime.org/feedback/{uuid}/{originalFilename}`
- Uploads are sequential (no goroutine fan-out needed for a low-volume feedback endpoint)

**GitHub issue body (Markdown template):**

```markdown
## Feedback from {name}

**Email:** {email}
**GitHub:** @{github}          ← line omitted if github is blank
**OpenReplay:** {sessionUrl}   ← line omitted if sessionUrl is blank

### Description
{description}

### Screenshots & Attachments
![{filename}]({wasabiUrl})     ← one line per attachment; section omitted if no attachments
```

**GitHub API call:**
- `POST https://api.github.com/repos/Keeping-History/rt911/issues`
- Auth: `Authorization: Bearer {GITHUB_FEEDBACK_TOKEN}`
- Body: `{"title": "[Feedback] {title}", "body": "...", "labels": ["feedback"]}`
- The `feedback` label is created on the repo at startup if it doesn't exist

**Response:**
- `200 {"ok": true, "issueUrl": "https://github.com/Keeping-History/rt911/issues/NNN"}`
- `400 {"error": "missing required field: name"}` etc.
- `502 {"error": "github api error: ..."}` if the GitHub call fails

---

## Infrastructure Changes

### k8s Secret

Add `GITHUB_FEEDBACK_TOKEN` to the streamer deployment's env. The token is a GitHub fine-grained PAT scoped to:
- Repository: `Keeping-History/rt911`
- Permissions: `Issues: Read and Write`

### nginx-s3-gateway (infra GitOps repo)

Add `/feedback/*` to the Traefik Ingress path allow-list so uploaded images are publicly served at `files.911realtime.org/feedback/...`.

### Vite dev proxy (`vite.config.ts`)

Add `/feedback` to the proxy target (same as other streamer routes) so `POST /feedback` works during local development.

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| Required field missing | Frontend: button stays disabled. Backend: 400 with field name. |
| Wasabi upload fails | Backend: 502, issue is not created, error returned to frontend |
| GitHub API fails | Backend: 502, error message surfaced inline in the form |
| Network error (fetch) | `useFeedback` catches, sets `error` state, form stays filled |
| OpenReplay not active | `getSessionURL()` returns `undefined`; session line omitted from issue |

---

## Testing

**Frontend:**
- `useFeedback.test.ts` — mock `fetch`, assert FormData contents, assert state transitions (idle → submitting → success/error)
- `FeedbackForm.test.tsx` — assert required field validation disables submit, assert thumbnail renders after file selection, assert screenshot button calls capture

**Backend:**
- `feedback_test.go` — table-driven tests for issue body formatting (with/without github, with/without sessionUrl, with/without attachments), handler validation (missing fields → 400), mock S3 and GitHub HTTP clients
