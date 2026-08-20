# Playlist Authentication & Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `plans/2026-07-16-playlist-auth-design.md` — the authority on semantics. Read its
History section first: the license key is INSTALLED and permission rules are verified un-gated;
the public published-only read filter is ALREADY LIVE.

**Goal:** Teachers sign in (Google SSO now; email+password when SMTP exists; Facebook/Apple when
their clients exist), own playlists enforced by native Directus permissions, and get a
`playlistApi.ts` seam the future editor consumes.

**Architecture:** Directus 12 (licensed) is both identity provider and enforcement layer: session
cookies on `.911realtime.org`, a Teacher role/policy with `$CURRENT_USER` item rules, and a
row-filtered public read. Frontend adds a non-persisted `AuthProvider`, a Classicy-styled Account
app, and two thin API modules. Zero backend/streamer changes; zero new services.

**Tech Stack:** Directus 12.1.1 REST (curl/bash for ops), Vite + React + TS, vitest, Playwright.

## Global Constraints

- Run one test file: `pnpm --filter @rt911/frontend exec vitest run <path>` (repo root). Full gate before PR: `pnpm build && pnpm lint && pnpm test`. Use `set -o pipefail` when chaining a test/typecheck command into `| head`/`| grep` before a commit — an unpiped failure must stop the chain.
- Frontend auth state must NEVER touch `localStorage` or the ClassicyStore — the httpOnly session cookie is the whole session; React context only.
- Every authed fetch uses `credentials: "include"`. Directus fetches are SEQUENTIAL — never `Promise.all` against api-beta (response-body mixing bug).
- Directus admin credentials for ops scripts: `ADMIN_EMAIL=admin@911realtime.org`, password from `kubectl get secret rt911-secrets -n rt911 -o jsonpath='{.data.ADMIN_PASSWORD}' | base64 -d`. NEVER echo secrets; NEVER commit them. Directus schema ops run SERIALLY (bursts wedge introspection; restart `rt911-api` if it wedges) and always log response bodies on failure.
- `rt911-config` (ConfigMap) and `rt911-secrets` (Secret) in namespace `rt911` are manually managed (no ArgoCD tracking labels — verified) — `kubectl patch` + `kubectl rollout restart deploy rt911-api -n rt911` is the correct ops path.
- New component test files need `afterEach(cleanup)` (no RTL auto-cleanup in this repo). Mock classicy PARTIALLY (`vi.mock("classicy", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), …overrides }))`).
- Never hand-edit the `classicy` version (pre-commit bumps it; an unrelated bump riding along is normal).
- New frontend files live in `packages/frontend/src/Providers/Auth/` (provider + api modules) and `packages/frontend/src/Applications/Account/` (the app). Paths below are relative to `packages/frontend/` unless noted.
- Account app copy: window title `Account`; sign-in button `Sign In`; permission-failure dialog copy is owned by callers (not this project) — this project's user-visible errors show the server's message or the exact strings given in Task 6.

---

### Task 1: Directus enforcement — apply + verify scripts (ops-as-code)

**Files:**
- Create: `scripts/playlist-auth/apply.sh` (repo root — sibling of the existing `scripts/` dir)
- Create: `scripts/playlist-auth/verify.sh`
- Create: `scripts/playlist-auth/README.md`

**Interfaces:**
- Consumes: live api-beta admin credentials (Global Constraints).
- Produces: Teacher role + policy on prod (ids echoed and recorded in README by the operator); `playlists` schema fields `user_created`/`date_created`/`date_updated`; the 4 Teacher permissions. `verify.sh` is the enforcement test suite AND the prod acceptance checklist. Task 2 needs the echoed `TEACHER_ROLE_ID`.

Both scripts take the instance URL as `$1` (default `https://api-beta.911realtime.org`) and read `DIRECTUS_ADMIN_PASSWORD` from the environment. They are idempotent where possible (apply checks-before-creates by name/field).

- [ ] **Step 1: Write `apply.sh`**

```bash
#!/usr/bin/env bash
# Create the Teacher role/policy, playlists ownership fields, and permissions.
# Idempotent: skips anything that already exists (matched by name/field).
# Usage: DIRECTUS_ADMIN_PASSWORD=... ./apply.sh [https://api-beta.911realtime.org]
set -euo pipefail
URL="${1:-https://api-beta.911realtime.org}"

TOKEN=$(curl -sS -X POST "$URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"admin@911realtime.org\",\"password\":\"$DIRECTUS_ADMIN_PASSWORD\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['access_token'])")
auth=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")

req() { # method path body — logs response body on non-2xx and exits
  local out; out=$(curl -sS -X "$1" "$URL$2" "${auth[@]}" ${3:+-d "$3"} -w $'\n%{http_code}')
  local code="${out##*$'\n'}" body="${out%$'\n'*}"
  if [[ "$code" != 2* ]]; then echo "FAILED $1 $2 -> $code: $body" >&2; exit 1; fi
  echo "$body"
}

# --- schema fields (serial; skip if present) -------------------------------
have_field() { req GET "/fields/playlists" | python3 -c "
import sys,json; print(any(f['field']=='$1' for f in json.load(sys.stdin)['data']))"; }
[ "$(have_field user_created)" = True ] || req POST /fields/playlists \
  '{"field":"user_created","type":"uuid","meta":{"special":["user-created"],"interface":"select-dropdown-m2o","readonly":true,"hidden":true},"schema":{}}' >/dev/null
[ "$(have_field date_created)" = True ] || req POST /fields/playlists \
  '{"field":"date_created","type":"timestamp","meta":{"special":["date-created"],"readonly":true,"hidden":true},"schema":{}}' >/dev/null
[ "$(have_field date_updated)" = True ] || req POST /fields/playlists \
  '{"field":"date_updated","type":"timestamp","meta":{"special":["date-updated"],"readonly":true,"hidden":true},"schema":{}}' >/dev/null
echo "fields: ok"

# --- Teacher policy + role --------------------------------------------------
POLICY_ID=$(req GET "/policies?filter[name][_eq]=Teacher&fields=id" \
  | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print(d[0]['id'] if d else '')")
if [ -z "$POLICY_ID" ]; then
  POLICY_ID=$(req POST /policies '{"name":"Teacher","app_access":false,"admin_access":false,"enforce_tfa":false}' \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
fi
ROLE_ID=$(req GET "/roles?filter[name][_eq]=Teacher&fields=id" \
  | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print(d[0]['id'] if d else '')")
if [ -z "$ROLE_ID" ]; then
  ROLE_ID=$(req POST /roles '{"name":"Teacher","description":"Playlist authors (frontend only)"}' \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
  req POST /access "{\"role\":\"$ROLE_ID\",\"policy\":\"$POLICY_ID\"}" >/dev/null
fi
echo "TEACHER_POLICY_ID=$POLICY_ID"
echo "TEACHER_ROLE_ID=$ROLE_ID"

# --- Teacher permissions on playlists (serial) ------------------------------
OWN='{"user_created":{"_eq":"$CURRENT_USER"}}'
STATUS_OK='{"status":{"_in":["draft","published"]}}'
have_perm() { req GET "/permissions?filter[policy][_eq]=$POLICY_ID&filter[collection][_eq]=playlists&filter[action][_eq]=$1&fields=id" \
  | python3 -c "import sys,json; print(bool(json.load(sys.stdin)['data']))"; }
[ "$(have_perm create)" = True ] || req POST /permissions \
  "{\"collection\":\"playlists\",\"action\":\"create\",\"policy\":\"$POLICY_ID\",\"fields\":[\"title\",\"definition\",\"status\"],\"validation\":$STATUS_OK}" >/dev/null
[ "$(have_perm read)" = True ] || req POST /permissions \
  "{\"collection\":\"playlists\",\"action\":\"read\",\"policy\":\"$POLICY_ID\",\"fields\":[\"*\"],\"permissions\":$OWN}" >/dev/null
[ "$(have_perm update)" = True ] || req POST /permissions \
  "{\"collection\":\"playlists\",\"action\":\"update\",\"policy\":\"$POLICY_ID\",\"fields\":[\"title\",\"definition\",\"status\"],\"permissions\":$OWN,\"validation\":$STATUS_OK}" >/dev/null
[ "$(have_perm delete)" = True ] || req POST /permissions \
  "{\"collection\":\"playlists\",\"action\":\"delete\",\"policy\":\"$POLICY_ID\",\"fields\":[\"*\"],\"permissions\":$OWN}" >/dev/null
echo "permissions: ok"
```

- [ ] **Step 2: Write `verify.sh` — the enforcement matrix test**

Creates two throwaway teacher users, exercises the full matrix with plain curl status-code
asserts, and cleans everything up (users + playlists) even on failure (trap). This is the
"failing test" of this task: it MUST fail (role missing) before `apply.sh` and pass after.

```bash
#!/usr/bin/env bash
# Enforcement matrix verification. Safe to run against prod: creates and removes
# its own users/playlists. Usage: DIRECTUS_ADMIN_PASSWORD=... ./verify.sh [url]
set -uo pipefail
URL="${1:-https://api-beta.911realtime.org}"
FAILS=0
check() { # description expected actual
  if [ "$2" = "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (expected $2 got $3)"; FAILS=$((FAILS+1)); fi
}
ADMIN_TOKEN=$(curl -sS -X POST "$URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"admin@911realtime.org\",\"password\":\"$DIRECTUS_ADMIN_PASSWORD\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['access_token'])")
ROLE_ID=$(curl -sS "$URL/roles?filter[name][_eq]=Teacher&fields=id" -H "Authorization: Bearer $ADMIN_TOKEN" \
  | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print(d[0]['id'] if d else '')")
[ -n "$ROLE_ID" ] || { echo "FAIL: Teacher role missing"; exit 1; }

PW="verify-$(date +%s)-Aa1!x"
mkuser() { curl -sS -X POST "$URL/users" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"email\":\"$1\",\"password\":\"$PW\",\"role\":\"$ROLE_ID\",\"status\":\"active\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])"; }
A_ID=$(mkuser "verify-teacher-a@example.com"); B_ID=$(mkuser "verify-teacher-b@example.com")
cleanup() {
  for id in ${A_PL:-} ${A_PUB:-}; do curl -sS -X DELETE "$URL/items/playlists/$id" -H "Authorization: Bearer $ADMIN_TOKEN" -o /dev/null; done
  for id in $A_ID $B_ID; do curl -sS -X DELETE "$URL/users/$id" -H "Authorization: Bearer $ADMIN_TOKEN" -o /dev/null; done
}
trap cleanup EXIT
login() { curl -sS -X POST "$URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$1\",\"password\":\"$PW\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['access_token'])"; }
TA=$(login "verify-teacher-a@example.com"); TB=$(login "verify-teacher-b@example.com")

DEF='{"version":1,"mode":"annotate","entries":[]}'
# create as A (draft) — expect 200, owner stamped
A_PL=$(curl -sS -X POST "$URL/items/playlists" -H "Authorization: Bearer $TA" -H "Content-Type: application/json" \
  -d "{\"title\":\"verify draft\",\"status\":\"draft\",\"definition\":$DEF}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
check "teacher can create draft" "ok" "$([ -n "$A_PL" ] && echo ok)"
OWNER=$(curl -sS "$URL/items/playlists/$A_PL?fields=user_created" -H "Authorization: Bearer $TA" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['user_created'])")
check "user_created auto-stamped to A" "$A_ID" "$OWNER"
# forged owner ignored on create
A_PUB=$(curl -sS -X POST "$URL/items/playlists" -H "Authorization: Bearer $TA" -H "Content-Type: application/json" \
  -d "{\"title\":\"verify pub\",\"status\":\"published\",\"definition\":$DEF,\"user_created\":\"$B_ID\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
OWNER2=$(curl -sS "$URL/items/playlists/$A_PUB?fields=user_created" -H "Authorization: Bearer $TA" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data'].get('user_created'))")
check "client-supplied user_created ignored" "$A_ID" "$OWNER2"
# matrix
code() { curl -sS -o /dev/null -w "%{http_code}" "$@"; }
check "A reads own draft"        200 "$(code "$URL/items/playlists/$A_PL"  -H "Authorization: Bearer $TA")"
check "B cannot read A's draft"  403 "$(code "$URL/items/playlists/$A_PL"  -H "Authorization: Bearer $TB")"
check "anon cannot read draft"   403 "$(code "$URL/items/playlists/$A_PL")"
check "anon reads published"     200 "$(code "$URL/items/playlists/$A_PUB")"
check "B reads published"        200 "$(code "$URL/items/playlists/$A_PUB" -H "Authorization: Bearer $TB")"
check "B cannot update A's row"  403 "$(code -X PATCH "$URL/items/playlists/$A_PUB" -H "Authorization: Bearer $TB" -H "Content-Type: application/json" -d '{"title":"hijack"}')"
check "A updates own row"        200 "$(code -X PATCH "$URL/items/playlists/$A_PL" -H "Authorization: Bearer $TA" -H "Content-Type: application/json" -d '{"title":"renamed"}')"
check "A cannot set bogus status" 400 "$(code -X PATCH "$URL/items/playlists/$A_PL" -H "Authorization: Bearer $TA" -H "Content-Type: application/json" -d '{"status":"hacked"}')"
check "B cannot delete A's row"  403 "$(code -X DELETE "$URL/items/playlists/$A_PL" -H "Authorization: Bearer $TB")"
check "A deletes own row"        204 "$(code -X DELETE "$URL/items/playlists/$A_PL" -H "Authorization: Bearer $TA")"
A_PL="" # deleted; skip in cleanup
echo; [ "$FAILS" -eq 0 ] && echo "ALL CHECKS PASSED" || { echo "$FAILS CHECK(S) FAILED"; exit 1; }
```

- [ ] **Step 3: Run `verify.sh` to confirm it fails before apply** — `DIRECTUS_ADMIN_PASSWORD=$(kubectl get secret rt911-secrets -n rt911 -o jsonpath='{.data.ADMIN_PASSWORD}' | base64 -d) bash scripts/playlist-auth/verify.sh`. Expected: `FAIL: Teacher role missing`, exit 1.
- [ ] **Step 4: Run `apply.sh`** — same env var pattern. Expected: `fields: ok`, echoed `TEACHER_POLICY_ID`/`TEACHER_ROLE_ID`, `permissions: ok`. Record both ids in `scripts/playlist-auth/README.md` (write the README: what the scripts do, the recorded ids, and that `verify.sh` doubles as the acceptance checklist).
- [ ] **Step 5: Run `verify.sh` to confirm the matrix passes** — Expected: every line `PASS`, `ALL CHECKS PASSED`. Also re-verify the student smoke playlist still loads anonymously: `curl -s -o /dev/null -w "%{http_code}" https://api-beta.911realtime.org/items/playlists/2b2b1bc0-0e42-478f-a55a-5c89cac31c8c` → 200.
- [ ] **Step 6: Commit** — `git add scripts/playlist-auth/ && git commit -m "feat(auth): Directus Teacher role/permissions apply + verify scripts"`.

---

### Task 2 (operator + config): Sessions, CORS, and Google SSO — live round-trip

**Files:** none in this repo (ConfigMap/Secret patches + `scripts/playlist-auth/README.md` ops log).

**Interfaces:**
- Consumes: `TEACHER_ROLE_ID` from Task 1; a Google OAuth client the operator creates at console.cloud.google.com (Web application; authorized redirect URI `https://api-beta.911realtime.org/auth/login/google/callback`).
- Produces: working session cookies for the frontend origin + a verified Google sign-in. Everything in Tasks 3–7 assumes these env vars are live.

- [ ] **Step 1: Patch session/CORS env** (values are verbatim):

```bash
kubectl patch configmap rt911-config -n rt911 --type merge -p '{"data":{
  "CORS_CREDENTIALS":"true",
  "SESSION_COOKIE_DOMAIN":".911realtime.org",
  "SESSION_COOKIE_SECURE":"true",
  "SESSION_COOKIE_SAME_SITE":"lax",
  "AUTH_PROVIDERS":"google",
  "AUTH_GOOGLE_DRIVER":"openid",
  "AUTH_GOOGLE_ISSUER_URL":"https://accounts.google.com",
  "AUTH_GOOGLE_IDENTIFIER_KEY":"email",
  "AUTH_GOOGLE_ALLOW_PUBLIC_REGISTRATION":"true",
  "AUTH_GOOGLE_DEFAULT_ROLE_ID":"<TEACHER_ROLE_ID from Task 1>",
  "AUTH_GOOGLE_REDIRECT_ALLOW_LIST":"https://beta.911realtime.org,https://beta.911realtime.org/"
}}'
kubectl patch secret rt911-secrets -n rt911 --type merge -p '{"stringData":{
  "AUTH_GOOGLE_CLIENT_ID":"<client id>",
  "AUTH_GOOGLE_CLIENT_SECRET":"<client secret>"
}}'
kubectl rollout restart deploy rt911-api -n rt911 && kubectl rollout status deploy rt911-api -n rt911 --timeout=180s
```

- [ ] **Step 2: Verify the provider is listed (this is the SSO-unlock confirmation):** `curl -s https://api-beta.911realtime.org/auth` → `{"data":[{"name":"google","driver":"openid",…}],…}`. If the list is empty, check pod logs for the license-tier warning before anything else.
- [ ] **Step 3: Live round-trip (manual, operator):** browse to `https://api-beta.911realtime.org/auth/login/google?redirect=https://beta.911realtime.org/` in a normal browser, complete Google sign-in, land back on beta, then confirm `curl` from the browser devtools: `fetch("https://api-beta.911realtime.org/users/me",{credentials:"include"}).then(r=>r.json())` returns your user with the Teacher role. Record the result in `scripts/playlist-auth/README.md` (date + who tested).
- [ ] **Step 4: Log deferred providers in README:** Facebook/Apple use the identical env pattern (`AUTH_PROVIDERS="google,facebook,apple"`, `AUTH_FACEBOOK_DRIVER=oauth2` + its authorize/access/profile URLs, `AUTH_APPLE_DRIVER=openid`) once their clients exist; email+password registration is enabled later via `PATCH /settings {"public_registration":true,"public_registration_role":"<TEACHER_ROLE_ID>","public_registration_verify_email":true}` **only after** `EMAIL_TRANSPORT` SMTP env exists. Also note: pin `directus/directus:latest` → `directus/directus:12.1.1` in the infra repo.
- [ ] **Step 5: Commit** the README update — `git add scripts/playlist-auth/README.md && git commit -m "docs(auth): ops log - session env + google sso verified"`.

---

### Task 3: `authApi.ts` — Directus auth REST wrapper

**Files:**
- Create: `src/Providers/Auth/authApi.ts`
- Modify: `src/Providers/Playlist/loadPlaylist.ts` (export the URL constant)
- Test: `src/Providers/Auth/authApi.test.ts`

**Interfaces:**
- Consumes: `DIRECTUS_URL` — add `export` to the existing `const DIRECTUS_URL` in `loadPlaylist.ts` and import it (single source for the API origin).
- Produces (Tasks 4/6 rely on these exact signatures):

```ts
export interface AuthUser { id: string; email: string | null; first_name: string | null; last_name: string | null }
export class AuthRequiredError extends Error {}   // thrown on 401
export class ForbiddenError extends Error {}      // thrown on 403
export async function fetchMe(fetchFn?: typeof fetch): Promise<AuthUser | null>; // null on 401 (anonymous is not an error)
export async function loginEmail(email: string, password: string, fetchFn?: typeof fetch): Promise<void>; // mode:"session"; throws Error(serverMessage) on failure
export async function logout(fetchFn?: typeof fetch): Promise<void>; // POST /auth/logout {mode:"session"}; ignores failures
export function providerLoginUrl(provider: "google" | "facebook" | "apple", redirectTo: string): string;
// `${DIRECTUS_URL}/auth/login/${provider}?redirect=${encodeURIComponent(redirectTo)}`
```

All calls use `credentials: "include"`. `loginEmail` body: `{ email, password, mode: "session" }`;
on non-OK, parse `{"errors":[{"message":…}]}` and throw `new Error(message)` (fallback
`"Sign-in failed"`). `fetchMe` GETs `/users/me?fields=id,email,first_name,last_name`; 401 →
`null`; other non-OK → throw.

- [ ] **Step 1: Write the failing test**

```ts
// src/Providers/Auth/authApi.test.ts
import { describe, expect, it, vi } from "vitest";
import { fetchMe, loginEmail, logout, providerLoginUrl } from "./authApi";

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status });

describe("providerLoginUrl", () => {
	it("builds the Directus SSO URL with an encoded redirect", () => {
		const url = providerLoginUrl("google", "https://beta.911realtime.org/");
		expect(url).toContain("/auth/login/google?redirect=");
		expect(url).toContain(encodeURIComponent("https://beta.911realtime.org/"));
	});
});

describe("fetchMe", () => {
	it("returns the user and sends credentials", async () => {
		const f = vi.fn(async (...args: Parameters<typeof fetch>) => {
			expect((args[1] as RequestInit).credentials).toBe("include");
			return jsonResponse({ data: { id: "u1", email: "t@x.org", first_name: "T", last_name: null } });
		});
		expect((await fetchMe(f))?.id).toBe("u1");
	});
	it("returns null on 401 (anonymous)", async () => {
		const f = vi.fn(async () => jsonResponse({ errors: [] }, 401));
		expect(await fetchMe(f)).toBeNull();
	});
	it("throws on other failures", async () => {
		const f = vi.fn(async () => jsonResponse({ errors: [] }, 500));
		await expect(fetchMe(f)).rejects.toThrow();
	});
});

describe("loginEmail", () => {
	it("POSTs session mode and resolves on success", async () => {
		const f = vi.fn(async (...args: Parameters<typeof fetch>) => {
			expect(JSON.parse(String((args[1] as RequestInit).body))).toMatchObject({ mode: "session" });
			return jsonResponse({ data: {} });
		});
		await expect(loginEmail("t@x.org", "pw", f)).resolves.toBeUndefined();
	});
	it("throws the server's message on failure", async () => {
		const f = vi.fn(async () => jsonResponse({ errors: [{ message: "Invalid user credentials." }] }, 401));
		await expect(loginEmail("t@x.org", "pw", f)).rejects.toThrow("Invalid user credentials.");
	});
});

describe("logout", () => {
	it("POSTs and swallows failures", async () => {
		const f = vi.fn(async () => new Response("x", { status: 500 }));
		await expect(logout(f)).resolves.toBeUndefined();
	});
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @rt911/frontend exec vitest run src/Providers/Auth/authApi.test.ts` → cannot resolve `./authApi`.
- [ ] **Step 3: Implement `authApi.ts`** per the Produces block (≈70 lines; export `DIRECTUS_URL` from `loadPlaylist.ts` first: change `const DIRECTUS_URL` to `export const DIRECTUS_URL`).
- [ ] **Step 4: Run to verify pass**, then `pnpm --filter @rt911/frontend exec tsc -b`.
- [ ] **Step 5: Commit** — `feat(auth): Directus auth REST wrapper`.

---

### Task 4: `AuthProvider` + `useAuth`

**Files:**
- Create: `src/Providers/Auth/AuthContext.ts`, `src/Providers/Auth/AuthProvider.tsx`
- Modify: `src/app.tsx` (mount inside `PlaylistProvider`, wrapping `MediaStreamProvider`'s parent level is NOT needed — auth and playlist are independent; mount as a sibling wrapper: `<PlaylistProvider><AuthProvider>…`)
- Test: `src/Providers/Auth/AuthProvider.test.tsx`

**Interfaces:**
- Consumes: `authApi.ts` (Task 3 signatures).
- Produces (Tasks 5/6 rely on):

```ts
export type AuthStatus = "loading" | "anonymous" | "signedIn";
export interface AuthContextValue {
	status: AuthStatus;
	user: AuthUser | null;
	signInWithEmail: (email: string, password: string) => Promise<void>; // loginEmail + refresh; rethrows
	signInWithProvider: (p: "google" | "facebook" | "apple") => void;     // window.location.assign(providerLoginUrl(p, window.location.href))
	signOut: () => Promise<void>;                                         // logout + set anonymous
	refresh: () => Promise<void>;                                         // re-fetchMe
}
export const AuthContext: React.Context<AuthContextValue>; // default: anonymous no-ops
export function useAuth(): AuthContextValue;
```

Provider behavior: on mount call `fetchMe()`; `null` → `anonymous`, user → `signedIn`, thrown →
`anonymous` (fail-open; console.warn). No persistence anywhere. StrictMode double-mount guarded
by a ref (same pattern as `PlaylistProvider`'s `loadStartedRef`).

- [ ] **Step 1: Write the failing test** — mock `./authApi` with `vi.mock`; four cases: boot→signedIn (fetchMe resolves user), boot→anonymous (null), signOut flips state and calls `logout`, `signInWithEmail` calls `loginEmail` then `fetchMe` again and flips to signedIn. Render a probe child that prints `status` + `user?.email`; `afterEach(cleanup)`. Complete test code mirrors Task 3's style with `waitFor` on the printed status.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** `AuthContext.ts` + `AuthProvider.tsx` (≈80 lines) and mount in `src/app.tsx`:

```tsx
<PlaylistProvider>
	<AuthProvider>
		<MediaStreamProvider>…existing children…</MediaStreamProvider>
	</AuthProvider>
</PlaylistProvider>
```

- [ ] **Step 4: Run tests + `tsc -b`.**
- [ ] **Step 5: Commit** — `feat(auth): AuthProvider context with session boot check`.

---

### Task 5: `playlistApi.ts` — the editor seam

**Files:**
- Create: `src/Providers/Auth/playlistApi.ts`
- Test: `src/Providers/Auth/playlistApi.test.ts`

**Interfaces:**
- Consumes: `DIRECTUS_URL` (Task 3 export), `parsePlaylist` from `../Playlist/parsePlaylist`, `AuthRequiredError`/`ForbiddenError` from `./authApi`.
- Produces (the future editor's complete surface):

```ts
export interface PlaylistSummary { id: string; title: string; status: string; date_updated: string | null; user_created: string | null }
export interface PlaylistRecord extends PlaylistSummary { definition: unknown }
export async function listMine(meId: string, fetchFn?: typeof fetch): Promise<PlaylistSummary[]>;
// GET /items/playlists?fields=id,title,status,date_updated,user_created&sort=-date_updated&limit=200
// then client-side .filter(r => r.user_created === meId)  (permissions return own + published)
export async function getPlaylist(id: string, fetchFn?: typeof fetch): Promise<PlaylistRecord>;
export async function createPlaylist(title: string, definition: unknown, fetchFn?: typeof fetch): Promise<PlaylistRecord>; // status:"draft"; REJECTS locally if parsePlaylist(definition).definition === null
export async function updatePlaylist(id: string, patch: { title?: string; definition?: unknown; status?: "draft" | "published" }, fetchFn?: typeof fetch): Promise<PlaylistRecord>; // same local validation when definition present
export async function deletePlaylist(id: string, fetchFn?: typeof fetch): Promise<void>;
export async function duplicatePlaylist(id: string, fetchFn?: typeof fetch): Promise<PlaylistRecord>;
// getPlaylist(id) then createPlaylist(`Copy of ${title}`, definition) — two SEQUENTIAL awaits
```

Shared response handling: 401 → `throw new AuthRequiredError(...)`, 403 → `throw new
ForbiddenError(...)`, other non-OK → `Error` with the server message. All `credentials:
"include"`.

- [ ] **Step 1: Write the failing test** — complete cases: listMine filters to `meId`; createPlaylist rejects an invalid definition locally WITHOUT calling fetch; createPlaylist POSTs `status:"draft"`; updatePlaylist maps 403 to `ForbiddenError` and 401 to `AuthRequiredError`; duplicatePlaylist composes `Copy of <title>` from two sequential calls (assert `f.mock.calls` order/URLs).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement (≈90 lines).**
- [ ] **Step 4: Run tests + `tsc -b`.**
- [ ] **Step 5: Commit** — `feat(auth): playlistApi seam for the future editor`.

---

### Task 6: Account app (Classicy-styled)

**Files:**
- Create: `src/Applications/Account/Account.tsx`, `src/Applications/Account/SignInForm.tsx`, `src/Applications/Account/app.png` (placeholder: `cp src/Applications/Feedback/app.png src/Applications/Account/app.png` — user swaps art later)
- Modify: `src/Desktop.tsx` (render `<Account />`)
- Test: `src/Applications/Account/Account.test.tsx`

**Interfaces:**
- Consumes: `useAuth()` (Task 4). Classicy components ONLY for UI: `ClassicyApp`, `ClassicyWindow`, `ClassicyButton`, `ClassicyInput`, `quitMenuItemHelper`, `registerClassicyIcons` — mirror `Feedback/Feedback.tsx`'s exact app/window/icon-registration shape (`appId = "Account.app"`, icon registered at `ClassicyIcons.applications.account.app`, window id `account_main`, title `Account`).
- Produces: the only auth UI in the product. Spec copy requirements (§2/§5, verbatim):
  - Signed out: provider buttons (`Sign in with Google` — Facebook/Apple buttons render only when their providers are live; v1 hardcodes `["google"]` in a `PROVIDERS` const with a comment pointing at Task 2's README), email + password `ClassicyInput`s, `Sign In` button. A `?reason=` query param on the page URL renders as the error line (SSO failure feedback).
  - Signed in: `Signed in as <first_name ?? email>`, a `Sign Out` button, and a static line `My Playlists — coming soon` (the editor project replaces it).
  - Preview origins (hostname ends with `github.io`): replace the form with `Sign-in is unavailable on preview builds.`
  - Email sign-in failure: show the thrown message verbatim under the form.

- [ ] **Step 1: Write the failing test** — partial-mock classicy (Global Constraints pattern) plus mock `../../Providers/Auth/AuthContext`'s `useAuth`. Cases: anonymous renders the form; `signInWithEmail` called with typed values on submit and its rejection message renders; signedIn renders identity + sign-out; `github.io` hostname renders the preview notice (use `window.history.replaceState` + `Object.defineProperty(window, "location", …)` is NOT needed — pass the hostname via a `hostnameForTest` optional prop defaulting to `window.location.hostname`).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** `Account.tsx` (app/window shell + view switch on `status`) and `SignInForm.tsx` (controlled `ClassicyInput`s + provider buttons calling `signInWithProvider`), register in `Desktop.tsx` after `<Feedback />`.
- [ ] **Step 4: Run tests + `tsc -b` + `pnpm lint`.**
- [ ] **Step 5: Commit** — `feat(auth): Account app with Classicy-native sign-in window`.

---

### Task 7: Playwright spec + docs

**Files:**
- Create: `e2e/tests/account.spec.ts`
- Modify: `packages/frontend/CLAUDE.md` ("What this package owns" bullet + mental-model note)
- Test: the spec itself

- [ ] **Step 1: Write the spec** — route-intercept `**/users/me` (first 401, then after form submit intercept `**/auth/login` → 200 and `**/users/me` → user JSON); double-click the `Account` desktop icon; assert the sign-in form is visible; fill email/password via `getByLabel`; click `Sign In`; assert `Signed in as` text appears. Assert behavior, never Classicy menus (flaky).
- [ ] **Step 2: Run** — `pnpm --filter @rt911/frontend exec playwright test e2e/tests/account.spec.ts` (Playwright starts the dev server; beware the stale-5173 trap — verify `/proc/<pid>/cwd` of any existing 5173 listener points at YOUR worktree, kill stale ones).
- [ ] **Step 3: CLAUDE.md** — add to "What this package does own": `src/Providers/Auth/ — Directus session auth (AuthProvider) + the playlistApi editor seam; auth state is never persisted client-side (httpOnly cookie only)`. Add an Account bullet to the Applications list sentence.
- [ ] **Step 4: Full gate** — `pnpm build && pnpm lint && pnpm test` + the playwright spec. All green.
- [ ] **Step 5: Commit** — `feat(auth): account e2e + docs`.

---

## Self-review notes (already applied)

- Spec coverage: §1 role/SSO/registration → T1/T2 (registration deferred behind SMTP, documented in T2 README step); §2 sessions/AuthProvider/Account styling → T2/T4/T6; §3 permissions matrix + non-forgeable owner + validation → T1 (verify.sh asserts every row incl. forged-owner and bogus-status); §3 duplicate client-side → T5; §4 seam + loadPlaylist untouched → T5 (loadPlaylist only gains an `export`); §5 error rows → T3 (classes), T6 (reason param, preview note, verbatim messages); §6 tests → T1 (matrix), T3–T6 (vitest), T7 (Playwright), live SSO = T2.
- Type consistency: `AuthUser`/`AuthRequiredError`/`ForbiddenError` defined in T3, consumed in T4/T5; `useAuth` shape in T4 consumed in T6; `PlaylistRecord` self-contained in T5.
- Deliberate deviations from spec defaults: none. Facebook/Apple/email are config-time additions (T2 step 4) — no code blocks on them.
- Ops sequencing: T1/T2 hit prod directly (beta instance, idempotent scripts, self-cleaning verifier) — matches how the playlists collection itself was provisioned.
