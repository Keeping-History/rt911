# Account "Special" Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Special tab to the Account app offering "Delete my data" and "Delete my account", backed by two new privileged routes on the `profile-api` Directus extension.

**Architecture:** A user cannot delete their own `directus_users` row and cannot reach `chat_messages` with user credentials, so all deletion happens server-side in the existing `profile-api` endpoint extension, which reads identity from `req.accountability.user` and acts with admin accountability. The frontend makes exactly one call per action, then clears localStorage and hard-reloads. Design: [`plans/2026-07-28-account-special-tab-design.md`](2026-07-28-account-special-tab-design.md).

**Tech Stack:** React 19 + TypeScript + Vite (frontend), Vitest + @testing-library/react (tests), `classicy` component library, Directus 12.1.1 endpoint extension (plain CommonJS, no build step), Postgres via the extension's knex instance.

## Global Constraints

- **Never delete `directus_files` rows or OpenReplay data.** Both actions preserve them. This is the user's explicit requirement.
- **Never delete `chat_blocks`.** Moderation standing must survive a data wipe, or a blocked student self-unbans in one click.
- **`chat_messages` and `chat_blocks` key on a column literally named `user`** — a reserved word in Postgres. Use the knex query builder (which auto-quotes identifiers), never a hand-written raw SQL string. Unquoted, `user` silently resolves to `CURRENT_USER` and matches the wrong rows without erroring.
- **Deleting the user row is blocked by five `NO ACTION` foreign keys** and must be preceded by nulling them. Verified against the live schema 2026-07-28. See Task 1.
- **Clearing localStorage without a full page reload is a no-op** — the live `ClassicyStore` holds the same state in memory and writes it straight back on its next dispatch. Always `clearLocalSettings()` then `reloadDesktop()`.
- **Identity always comes from `req.accountability.user`**, never from the request body. Matches the existing routes in the same file.
- **`classicy` is pinned to `"latest"` and auto-bumped by `.husky/pre-commit`.** Never hand-edit its version; an unrelated version bump riding along in a commit is expected.
- Frontend uses **tabs for indentation** and double quotes, matching the surrounding files.

## Prerequisite

This worktree has no `node_modules`. Before Task 2:

```bash
cd /home/robbiebyrd/rt911/.claude/worktrees/account-special-tab
pnpm install
```

## File Structure

| File | Responsibility |
|---|---|
| `packages/directus-extensions/profile-api/src/index.js` *(modify)* | Add `eraseOwnedData`, `blankProfile`, `POST /delete-data`, `POST /delete-account`; fix `CONFIRM_BASE_URL` |
| `packages/frontend/src/Providers/Auth/accountApi.ts` *(create)* | Client seam: `deleteMyData`, `deleteMyAccount`, `clearLocalSettings`, `reloadDesktop` |
| `packages/frontend/src/Providers/Auth/accountApi.test.ts` *(create)* | Request shape, error mapping, key list |
| `packages/frontend/src/Applications/Account/SpecialTab.tsx` *(create)* | Buttons, risk copy, confirmation alerts, typed-confirm gating |
| `packages/frontend/src/Applications/Account/SpecialTab.test.tsx` *(create)* | Confirmation-before-network, Cancel, gating, failure path |
| `packages/frontend/src/Applications/Account/ProfileEditor.tsx` *(modify)* | Append the Special tab entry |
| `packages/frontend/src/Applications/Account/Account.module.scss` *(modify)* | `.destructive`, `.riskCopy` styles |

`SpecialTab` is its own file rather than a fifth inline entry in `ProfileEditor`'s `tabs` array — that array is already ~160 lines of JSX and this tab carries real interaction state (which action is pending, what has been typed, busy, error).

---

### Task 1: Extension routes

**Files:**
- Modify: `packages/directus-extensions/profile-api/src/index.js`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `POST /profile/delete-data` and `POST /profile/delete-account`. Both require a session cookie, take no request body, and return `200 {"data":{"deleted":{"<collection>":<count>,…},"failed":["<collection>",…]}}`. Both return `401 {"errors":[{"message":…}]}` when unauthenticated. `/delete-account` additionally returns `500` if the user row itself could not be deleted.

There is no test harness in `packages/directus-extensions`, so this task's verification is manual (Task 5). Write it carefully — it is the riskiest code in this change and nothing in CI covers it.

- [ ] **Step 1: Fix the hardcoded confirmation host**

`CONFIRM_BASE_URL` currently sits at module scope pointing at `beta.911realtime.org`. Delete that line (line 14) and derive it inside `handler`, where `env` is in scope.

Remove:

```js
const CONFIRM_BASE_URL = "https://beta.911realtime.org/?confirm-email=";
```

Add immediately after `const admin = { admin: true, role: null };` inside `handler`:

```js
		// The desktop app's own origin, NOT Directus's PUBLIC_URL — that one
		// holds the API's URL (api.911realtime.org), and mailing a confirmation
		// link there would send people into the REST API instead of the app.
		const confirmBaseUrl = `${env.RT911_APP_URL || "https://911realtime.org"}/?confirm-email=`;
```

Then update the one use inside the `/email-change` route body — change `${CONFIRM_BASE_URL}${token}` to `${confirmBaseUrl}${token}`.

- [ ] **Step 2: Add the shared constants**

Place directly above `module.exports`:

```js
// Collections whose rows belong to one user and go with them. Every one of
// these is keyed by `user_created`; chat_messages is handled separately
// because it is written by the Go streamer, not Directus, and keys on "user".
const OWNED_COLLECTIONS = ["playlists", "stacks", "tm_bookmarks_personal"];

// Profile fields blanked by a data wipe. `email` is absent deliberately — it
// is the login identity, and the account survives a data wipe.
const PROFILE_FIELDS = [
	"first_name", "last_name", "username", "city", "state", "country",
	"school_name", "educator_role", "grade_levels", "subjects",
	"avatar", "filesystem",
];

// Foreign keys onto directus_users declared ON DELETE NO ACTION. Postgres
// REJECTS the user delete while any of them still points at the row — this is
// not a data-loss risk, it is a hard failure, and it fires for every account
// that has ever uploaded an avatar. Nulling them is idempotent, so a retried
// deletion is safe. tm_bookmarks_personal is the sixth such FK and resolves
// itself: eraseOwnedData deletes those rows outright, which is why data
// erasure must run BEFORE the row delete rather than after.
const BLOCKING_REFS = [
	["directus_files", "uploaded_by"],
	["directus_files", "modified_by"],
	["directus_notifications", "sender"],
	["directus_versions", "user_updated"],
	["directus_comments", "user_updated"],
];
```

- [ ] **Step 3: Add the erase and blank helpers**

Inside `handler`, after the existing `emailTaken` function. `database` must be added to the destructured context on the `handler` line — change `const { services, getSchema, env, logger } = context;` to `const { services, getSchema, env, logger, database } = context;`.

```js
			// Deletes everything this user owns, EXCEPT their directus_files
			// (kept by product requirement) and their chat_blocks (moderation
			// standing must outlive a data wipe, or a blocked student clears
			// their own cool-down and the supporting evidence in one click).
			//
			// Each group is wrapped independently rather than aborting on the
			// first error: someone who asked to be forgotten should have as
			// much removed as possible, and the caller reports what remains.
			async function eraseOwnedData(userId, schema) {
				const deleted = {};
				const failed = [];

				for (const collection of OWNED_COLLECTIONS) {
					try {
						const items = new services.ItemsService(collection, { schema, accountability: admin });
						const rows = await items.readByQuery({
							filter: { user_created: { _eq: userId } },
							fields: ["id"],
							limit: -1,
						});
						if (rows.length > 0) await items.deleteMany(rows.map((r) => r.id));
						deleted[collection] = rows.length;
					} catch (err) {
						logger.error(err, `profile-api: could not erase ${collection} for ${userId}`);
						failed.push(collection);
					}
				}

				try {
					// Query builder, not raw SQL: knex quotes identifiers, and
					// "user" is a reserved word that resolves to CURRENT_USER
					// unquoted -- matching the wrong rows without erroring.
					deleted.chat_messages = await database("chat_messages").where("user", userId).del();
				} catch (err) {
					logger.error(err, `profile-api: could not erase chat_messages for ${userId}`);
					failed.push("chat_messages");
				}

				return { deleted, failed };
			}

			// Nulls every profile field, leaving the account signed-in-able.
			async function blankProfile(userId, schema) {
				const patch = {};
				for (const field of PROFILE_FIELDS) patch[field] = null;
				const users = new UsersService({ schema, accountability: admin });
				await users.updateOne(userId, patch);
			}
```

- [ ] **Step 4: Add the delete-data route**

```js
			router.post("/delete-data", async (req, res) => {
				try {
					const userId = req.accountability && req.accountability.user;
					if (!userId) return errors(res, 401, "You must be signed in.");
					const schema = await getSchema();
					const result = await eraseOwnedData(userId, schema);
					try {
						await blankProfile(userId, schema);
						result.deleted.profile = 1;
					} catch (err) {
						logger.error(err, `profile-api: could not blank profile for ${userId}`);
						result.failed.push("profile");
					}
					logger.info(`profile-api: data erased for user ${userId}`);
					return res.status(200).json({ data: result });
				} catch (err) {
					logger.error(err, "profile-api: delete-data failed");
					return errors(res, 500, "Could not delete your data.");
				}
			});
```

- [ ] **Step 5: Add the delete-account route**

Note the ordering: erase owned data, blank the profile, clear blocking references, *then* delete the row. A failure at the final step is a hard 500 — the client must not clear local storage or reload, because the account still exists.

```js
			router.post("/delete-account", async (req, res) => {
				try {
					const userId = req.accountability && req.accountability.user;
					if (!userId) return errors(res, 401, "You must be signed in.");
					const schema = await getSchema();

					const result = await eraseOwnedData(userId, schema);
					try {
						await blankProfile(userId, schema);
					} catch (err) {
						// Not fatal: the row is about to be deleted anyway. Logged
						// so a partial failure is still visible if the delete then
						// fails too and the account survives scrubbed.
						logger.error(err, `profile-api: could not blank profile for ${userId}`);
					}

					// Must happen before deleteOne -- see BLOCKING_REFS.
					for (const [table, column] of BLOCKING_REFS) {
						await database(table).where(column, userId).update({ [column]: null });
					}

					const users = new UsersService({ schema, accountability: admin });
					await users.deleteOne(userId);

					result.deleted.account = 1;
					logger.info(`profile-api: account deleted for user ${userId}`);
					return res.status(200).json({ data: result });
				} catch (err) {
					logger.error(err, "profile-api: delete-account failed");
					return errors(res, 500, "Could not delete your account.");
				}
			});
```

- [ ] **Step 6: Verify the file parses**

Run: `node --check packages/directus-extensions/profile-api/src/index.js`
Expected: no output (exit 0). This is the only automated check available for this file.

- [ ] **Step 7: Commit**

```bash
git add packages/directus-extensions/profile-api/src/index.js
git commit -m "feat(profile-api): delete-data and delete-account routes

A user cannot delete their own directus_users row and cannot reach
chat_messages with user credentials, so both actions run here with admin
accountability against an identity taken from req.accountability.

Five NO ACTION foreign keys onto directus_users must be nulled before the
row delete or Postgres rejects it -- directus_files.uploaded_by fires for
every account that has ever uploaded an avatar. Files and chat_blocks are
preserved by requirement.

Also moves the email-change confirmation host off the hardcoded beta
subdomain to env-driven RT911_APP_URL, defaulting to the apex."
```

---

### Task 2: Client API seam

**Files:**
- Create: `packages/frontend/src/Providers/Auth/accountApi.ts`
- Test: `packages/frontend/src/Providers/Auth/accountApi.test.ts`

**Interfaces:**
- Consumes: Task 1's two routes; `AuthRequiredError` / `ForbiddenError` from `./authApi`; `DIRECTUS_URL` from `../../lib/endpoints`.
- Produces:
  - `interface DeletionResult { deleted: Record<string, number>; failed: string[] }`
  - `deleteMyData(fetchFn?: typeof fetch): Promise<DeletionResult>`
  - `deleteMyAccount(fetchFn?: typeof fetch): Promise<DeletionResult>`
  - `clearLocalSettings(storage?: Storage): void`
  - `reloadDesktop(): void`
  - `SETTINGS_KEYS: readonly string[]`

- [ ] **Step 1: Write the failing test**

Create `packages/frontend/src/Providers/Auth/accountApi.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { AuthRequiredError, ForbiddenError } from "./authApi";
import { SETTINGS_KEYS, clearLocalSettings, deleteMyAccount, deleteMyData } from "./accountApi";

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status });

describe("deleteMyData", () => {
	it("POSTs to /profile/delete-data with credentials and no body", async () => {
		const f = vi.fn(async (...args: Parameters<typeof fetch>) => {
			expect(String(args[0])).toContain("/profile/delete-data");
			const init = args[1] as RequestInit;
			expect(init.method).toBe("POST");
			expect(init.credentials).toBe("include");
			expect(init.body).toBeUndefined();
			return jsonResponse({ data: { deleted: { playlists: 2 }, failed: [] } });
		});
		const result = await deleteMyData(f);
		expect(result.deleted.playlists).toBe(2);
		expect(result.failed).toEqual([]);
	});

	it("maps 401/403 to the shared error classes", async () => {
		await expect(deleteMyData(vi.fn(async () => jsonResponse({}, 401)))).rejects.toBeInstanceOf(
			AuthRequiredError,
		);
		await expect(deleteMyData(vi.fn(async () => jsonResponse({}, 403)))).rejects.toBeInstanceOf(
			ForbiddenError,
		);
	});

	it("surfaces the server's message on failure", async () => {
		const f = vi.fn(async () => jsonResponse({ errors: [{ message: "Could not delete your data." }] }, 500));
		await expect(deleteMyData(f)).rejects.toThrow("Could not delete your data.");
	});
});

describe("deleteMyAccount", () => {
	it("POSTs to /profile/delete-account", async () => {
		const f = vi.fn(async (...args: Parameters<typeof fetch>) => {
			expect(String(args[0])).toContain("/profile/delete-account");
			return jsonResponse({ data: { deleted: { account: 1 }, failed: [] } });
		});
		expect((await deleteMyAccount(f)).deleted.account).toBe(1);
	});

	it("rejects on 500 so the caller can skip the reload", async () => {
		const f = vi.fn(async () => jsonResponse({ errors: [{ message: "boom" }] }, 500));
		await expect(deleteMyAccount(f)).rejects.toThrow("boom");
	});
});

describe("clearLocalSettings", () => {
	it("removes every persisted settings key", () => {
		const store = new Map<string, string>(SETTINGS_KEYS.map((k) => [k, "x"]));
		store.set("somethingElse", "keep");
		const storage = {
			removeItem: (k: string) => void store.delete(k),
		} as unknown as Storage;

		clearLocalSettings(storage);

		for (const key of SETTINGS_KEYS) expect(store.has(key)).toBe(false);
		expect(store.get("somethingElse")).toBe("keep");
	});

	it("includes the Classicy desktop state key", () => {
		// The single key holding every app's settings and window positions.
		// If this is ever dropped, "delete my data" silently keeps everything.
		expect(SETTINGS_KEYS).toContain("classicyDesktopState");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Providers/Auth/accountApi.test.ts`
Expected: FAIL — cannot resolve `./accountApi`.

- [ ] **Step 3: Write the implementation**

Create `packages/frontend/src/Providers/Auth/accountApi.ts`:

```ts
// Account-deletion seam. Both routes live on the profile-api Directus
// extension because neither action is possible with user credentials: the
// Teacher policy grants no delete on directus_users, and chat_messages is not
// a Directus-managed collection. Spec: plans/2026-07-28-account-special-tab-design.md
import { AuthRequiredError, ForbiddenError } from "./authApi";
import { DIRECTUS_URL } from "../../lib/endpoints";

/** Per-collection row counts the server actually removed, plus what it could not. */
export interface DeletionResult {
	deleted: Record<string, number>;
	failed: string[];
}

/**
 * Every localStorage key holding user settings.
 *
 * `classicyDesktopState` is the big one: the Classicy store persists window
 * positions AND every app's settings (Feedback, RadioScanner, README,
 * TimeMachine, TV selections) into that single key.
 */
export const SETTINGS_KEYS = [
	"classicyDesktopState",
	"rt911AlertsEnabled",
	"media-chrome-pref-muted",
	"media-chrome-pref-volume",
	"media-chrome-pref-subtitles-lang",
] as const;

interface DirectusErrorBody {
	errors?: { message?: unknown }[];
}

async function serverMessage(res: Response, fallback: string): Promise<string> {
	try {
		const body = (await res.json()) as DirectusErrorBody;
		const message = body.errors?.[0]?.message;
		return typeof message === "string" ? message : fallback;
	} catch {
		return fallback;
	}
}

async function post(path: string, fallback: string, fetchFn: typeof fetch): Promise<DeletionResult> {
	const res = await fetchFn(`${DIRECTUS_URL}${path}`, {
		method: "POST",
		credentials: "include",
	});
	if (res.status === 401) throw new AuthRequiredError(await serverMessage(res, fallback));
	if (res.status === 403) throw new ForbiddenError(await serverMessage(res, fallback));
	if (!res.ok) throw new Error(await serverMessage(res, fallback));
	const body = (await res.json()) as { data: DeletionResult };
	return body.data;
}

/** Erase the user's content and blank their profile. The account survives. */
export async function deleteMyData(fetchFn: typeof fetch = fetch): Promise<DeletionResult> {
	return post("/profile/delete-data", "Could not delete your data.", fetchFn);
}

/** Erase everything above, then remove the account itself. Irreversible. */
export async function deleteMyAccount(fetchFn: typeof fetch = fetch): Promise<DeletionResult> {
	return post("/profile/delete-account", "Could not delete your account.", fetchFn);
}

/** Drop every persisted setting. Must be followed by reloadDesktop() — see below. */
export function clearLocalSettings(storage: Storage = window.localStorage): void {
	for (const key of SETTINGS_KEYS) storage.removeItem(key);
}

/**
 * Hard reload, and it is load-bearing rather than cosmetic.
 *
 * The live ClassicyStore holds the same settings in memory and writes them
 * straight back to localStorage on its next dispatch, so clearing the keys
 * without reloading is a no-op. The reload also discards the in-memory
 * FilesystemSync tree, which would otherwise re-push itself to a `filesystem`
 * link the server just nulled.
 */
export function reloadDesktop(): void {
	window.location.reload();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Providers/Auth/accountApi.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Providers/Auth/accountApi.ts packages/frontend/src/Providers/Auth/accountApi.test.ts
git commit -m "feat(account): client seam for delete-data / delete-account

clearLocalSettings must be followed by reloadDesktop: the live ClassicyStore
holds the same settings in memory and rewrites them on its next dispatch, so
clearing the keys alone changes nothing."
```

---

### Task 3: Special tab component

**Files:**
- Create: `packages/frontend/src/Applications/Account/SpecialTab.tsx`
- Test: `packages/frontend/src/Applications/Account/SpecialTab.test.tsx`
- Modify: `packages/frontend/src/Applications/Account/Account.module.scss`

**Interfaces:**
- Consumes: `deleteMyData`, `deleteMyAccount`, `clearLocalSettings`, `reloadDesktop` from `../../Providers/Auth/accountApi`; `useAuth` from `../../Providers/Auth/AuthContext`.
- Produces: `export const SpecialTab: React.FC` — takes no props, reads the signed-in user from context.

- [ ] **Step 1: Add the styles**

Append to `packages/frontend/src/Applications/Account/Account.module.scss`:

```scss
// Special tab: the two irreversible actions. Kept visually quiet rather than
// alarm-red — the alert carries the warning, and a scary-looking button invites
// curiosity clicks.
.riskCopy {
	color: var(--color-system-06);
	max-width: 40ch;
}

.destructive {
	display: flex;
	flex-direction: column;
	gap: calc(var(--window-padding-size) / 4);
	align-items: flex-start;
	padding-top: calc(var(--window-padding-size) / 2);
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/frontend/src/Applications/Account/SpecialTab.test.tsx`. The `classicy` mock is **partial** via `importOriginal` — a full `vi.mock("classicy")` breaks the moment the component imports something new. The `ClassicyAlert` stand-in renders *every* button with its `disabled` state, which is what makes the typed-confirm gating testable.

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import type { AuthUser } from "../../Providers/Auth/authApi";

const mockDeleteMyData = vi.hoisted(() => vi.fn());
const mockDeleteMyAccount = vi.hoisted(() => vi.fn());
const mockClearLocalSettings = vi.hoisted(() => vi.fn());
const mockReloadDesktop = vi.hoisted(() => vi.fn());

vi.mock("../../Providers/Auth/accountApi", () => ({
	deleteMyData: mockDeleteMyData,
	deleteMyAccount: mockDeleteMyAccount,
	clearLocalSettings: mockClearLocalSettings,
	reloadDesktop: mockReloadDesktop,
}));

const mockAuth = vi.hoisted(() => ({ user: null as AuthUser | null }));
vi.mock("../../Providers/Auth/AuthContext", () => ({ useAuth: () => mockAuth }));

vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	// Renders label, message and ALL buttons with their disabled state, so
	// tests can drive the typed-confirm gate without classicy's window chrome.
	ClassicyAlert: ({
		label,
		message,
		buttons,
	}: {
		label: string;
		message?: React.ReactNode;
		buttons?: { label: string; disabled?: boolean; onClick?: () => void }[];
	}) => (
		<div role="alertdialog" aria-label={label}>
			<span>{label}</span>
			{message}
			{buttons?.map((b) => (
				<button key={b.label} type="button" disabled={b.disabled} onClick={b.onClick}>
					{b.label}
				</button>
			))}
		</div>
	),
}));

import { SpecialTab } from "./SpecialTab";

const makeUser = (over: Partial<AuthUser> = {}): AuthUser => ({
	id: "1", email: "t@x.org", username: "mrbyrd", first_name: null, last_name: null,
	avatar: null, provider: "google", city: null, state: null, country: null,
	school_name: null, educator_role: null, grade_levels: null, subjects: null,
	...over,
});

beforeEach(() => {
	mockAuth.user = makeUser();
	mockDeleteMyData.mockReset().mockResolvedValue({ deleted: {}, failed: [] });
	mockDeleteMyAccount.mockReset().mockResolvedValue({ deleted: {}, failed: [] });
	mockClearLocalSettings.mockReset();
	mockReloadDesktop.mockReset();
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("SpecialTab — delete my data", () => {
	it("shows a confirmation before touching the network", () => {
		render(<SpecialTab />);
		fireEvent.click(screen.getByRole("button", { name: "Delete My Data" }));
		expect(screen.getByRole("alertdialog")).toBeTruthy();
		expect(mockDeleteMyData).not.toHaveBeenCalled();
	});

	it("cancelling issues no request", () => {
		render(<SpecialTab />);
		fireEvent.click(screen.getByRole("button", { name: "Delete My Data" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(mockDeleteMyData).not.toHaveBeenCalled();
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("confirming deletes, clears settings, then reloads", async () => {
		render(<SpecialTab />);
		fireEvent.click(screen.getByRole("button", { name: "Delete My Data" }));
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(mockReloadDesktop).toHaveBeenCalled());
		expect(mockDeleteMyData).toHaveBeenCalled();
		expect(mockClearLocalSettings).toHaveBeenCalled();
	});

	it("does not clear settings or reload when the server fails", async () => {
		mockDeleteMyData.mockRejectedValue(new Error("Could not delete your data."));
		render(<SpecialTab />);
		fireEvent.click(screen.getByRole("button", { name: "Delete My Data" }));
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(screen.getByText("Could not delete your data.")).toBeTruthy());
		expect(mockClearLocalSettings).not.toHaveBeenCalled();
		expect(mockReloadDesktop).not.toHaveBeenCalled();
	});
});

describe("SpecialTab — delete my account", () => {
	const openAccountAlert = () => {
		render(<SpecialTab />);
		fireEvent.click(screen.getByRole("button", { name: "Delete My Account" }));
	};

	it("keeps Delete disabled until the screen name matches exactly", () => {
		openAccountAlert();
		const del = () => screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement;
		expect(del().disabled).toBe(true);

		fireEvent.change(screen.getByLabelText("Type your screen name to confirm"), {
			target: { value: "mrbyr" },
		});
		expect(del().disabled).toBe(true);

		fireEvent.change(screen.getByLabelText("Type your screen name to confirm"), {
			target: { value: "mrbyrd" },
		});
		expect(del().disabled).toBe(false);
	});

	it("falls back to the email when the account has no screen name", () => {
		mockAuth.user = makeUser({ username: null });
		openAccountAlert();
		fireEvent.change(screen.getByLabelText("Type your screen name to confirm"), {
			target: { value: "t@x.org" },
		});
		expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(false);
	});

	it("deletes, clears settings, then reloads on confirm", async () => {
		openAccountAlert();
		fireEvent.change(screen.getByLabelText("Type your screen name to confirm"), {
			target: { value: "mrbyrd" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(mockReloadDesktop).toHaveBeenCalled());
		expect(mockDeleteMyAccount).toHaveBeenCalled();
		expect(mockClearLocalSettings).toHaveBeenCalled();
	});

	it("does not clear settings or reload when the account delete fails", async () => {
		mockDeleteMyAccount.mockRejectedValue(new Error("Could not delete your account."));
		openAccountAlert();
		fireEvent.change(screen.getByLabelText("Type your screen name to confirm"), {
			target: { value: "mrbyrd" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(screen.getByText("Could not delete your account.")).toBeTruthy());
		expect(mockClearLocalSettings).not.toHaveBeenCalled();
		expect(mockReloadDesktop).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/Account/SpecialTab.test.tsx`
Expected: FAIL — cannot resolve `./SpecialTab`.

- [ ] **Step 4: Write the implementation**

Create `packages/frontend/src/Applications/Account/SpecialTab.tsx`:

```tsx
// Account → Special: the two irreversible actions. Both run entirely on the
// server (profile-api extension) because neither is possible with user
// credentials. Spec: plans/2026-07-28-account-special-tab-design.md
import { ClassicyAlert, ClassicyButton, ClassicyControlLabel, ClassicyInput } from "classicy";
import type React from "react";
import { useState } from "react";
import { useAuth } from "../../Providers/Auth/AuthContext";
import {
	clearLocalSettings,
	deleteMyAccount,
	deleteMyData,
	reloadDesktop,
} from "../../Providers/Auth/accountApi";
import styles from "./Account.module.scss";

type Pending = "data" | "account" | null;

export const SpecialTab: React.FC = () => {
	const { user } = useAuth();
	const [pending, setPending] = useState<Pending>(null);
	const [typed, setTyped] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// What the user must type to arm account deletion. Screen name is the
	// identity they actually recognise; email is the fallback for accounts
	// that never set one.
	const confirmName = user?.username ?? user?.email ?? "";

	const close = () => {
		setPending(null);
		setTyped("");
	};

	const run = (action: () => Promise<unknown>) => {
		setBusy(true);
		setError(null);
		action()
			.then(() => {
				// Order matters: the server wipe must have succeeded before we
				// drop local state, and the reload is what makes clearing the
				// keys stick (see accountApi.reloadDesktop).
				clearLocalSettings();
				reloadDesktop();
			})
			.catch((err: Error) => {
				setError(err.message);
				close();
			})
			.finally(() => setBusy(false));
	};

	return (
		<div className={styles.tabPanel}>
			<div className={styles.destructive}>
				<ClassicyControlLabel label="Delete my data" />
				<div className={styles.riskCopy}>
					Erases your profile, desktop settings, playlists, stacks, bookmarks and
					chat history. Your account and your uploaded files are kept.
				</div>
				<ClassicyButton disabled={busy} onClickFunc={() => setPending("data")}>
					Delete My Data
				</ClassicyButton>
			</div>

			<div className={styles.destructive}>
				<ClassicyControlLabel label="Delete my account" />
				<div className={styles.riskCopy}>
					Everything above, and then your account itself. You will be signed out and
					cannot sign back in. Your uploaded files are kept.
				</div>
				<ClassicyButton disabled={busy} onClickFunc={() => setPending("account")}>
					Delete My Account
				</ClassicyButton>
			</div>

			{error && <div className={styles.error}>{error}</div>}

			{pending === "data" && (
				<ClassicyAlert
					id="account_delete_data"
					appId="Account.app"
					alertType="stop"
					title="Account"
					label="This cannot be undone."
					message="Deletes your profile, settings, playlists, stacks, bookmarks and chat history. Keeps your files and your login."
					// HIG: when an action risks data loss the SAFE choice is the
					// default, so Return dismisses rather than destroys.
					defaultButtonId="account_delete_data_cancel"
					buttons={[
						{ id: "account_delete_data_cancel", label: "Cancel", role: "cancel", onClick: close },
						{
							id: "account_delete_data_go",
							label: "Delete",
							role: "normal",
							disabled: busy,
							onClick: () => run(deleteMyData),
						},
					]}
				/>
			)}

			{pending === "account" && (
				<ClassicyAlert
					id="account_delete_account"
					appId="Account.app"
					alertType="stop"
					title="Account"
					label="This cannot be undone."
					message={
						<div>
							<p>
								Your account and everything in it will be permanently removed. Your
								uploaded files are kept.
							</p>
							<ClassicyInput
								id="account-delete-confirm"
								labelTitle="Type your screen name to confirm"
								prefillValue={typed}
								disabled={busy}
								onChangeFunc={(e) => setTyped(e.target.value)}
							/>
						</div>
					}
					defaultButtonId="account_delete_account_cancel"
					buttons={[
						{ id: "account_delete_account_cancel", label: "Cancel", role: "cancel", onClick: close },
						{
							id: "account_delete_account_go",
							label: "Delete",
							role: "normal",
							// Exact match only. A near-miss is a near-miss.
							disabled: busy || typed !== confirmName,
							onClick: () => run(deleteMyAccount),
						},
					]}
				/>
			)}
		</div>
	);
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/Account/SpecialTab.test.tsx`
Expected: PASS, 9 tests.

If the typed-confirm tests fail on `getByLabelText`, check how `ClassicyInput` associates its `labelTitle` with the input — `ProfileEditor.test.tsx` queries its fields the same way (`screen.getByLabelText("First Name")`), so the pattern is known to work.

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/Applications/Account/SpecialTab.tsx packages/frontend/src/Applications/Account/SpecialTab.test.tsx packages/frontend/src/Applications/Account/Account.module.scss
git commit -m "feat(account): Special tab with delete-data and delete-account

Friction scales with severity: the data wipe takes one stop alert, the
account deletion additionally requires typing the screen name. Cancel is the
default button on both, per the HIG rule for data-loss actions."
```

---

### Task 4: Wire the tab into ProfileEditor

**Files:**
- Modify: `packages/frontend/src/Applications/Account/ProfileEditor.tsx`
- Test: `packages/frontend/src/Applications/Account/ProfileEditor.test.tsx`

**Interfaces:**
- Consumes: `SpecialTab` from `./SpecialTab`.
- Produces: a fifth (or fourth, for OAuth accounts) tab titled `Special`.

- [ ] **Step 1: Write the failing test**

Append to `packages/frontend/src/Applications/Account/ProfileEditor.test.tsx`. The existing file already defines `selectTab`; reuse it.

```tsx
describe("ProfileEditor — Special tab", () => {
	it("offers both destructive actions", () => {
		render(<ProfileEditor />);
		selectTab("Special");
		expect(screen.getByRole("button", { name: "Delete My Data" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Delete My Account" })).toBeTruthy();
	});

	it("is the last tab, after Password", () => {
		// Order is deliberate: the destructive actions sit furthest from the
		// tabs someone uses routinely.
		mockAuth.user = makeUser({ provider: "default" });
		render(<ProfileEditor />);
		const titles = screen.getAllByRole("tab").map((t) => t.textContent);
		expect(titles[titles.length - 1]).toBe("Special");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/Account/ProfileEditor.test.tsx -t "Special"`
Expected: FAIL — no tab named "Special".

- [ ] **Step 3: Add the import**

In `ProfileEditor.tsx`, add after the `usernameApi` import:

```tsx
import { SpecialTab } from "./SpecialTab";
```

- [ ] **Step 4: Append the tab**

After the `if (user?.provider === "default") { tabs.push({...}) }` block and before `return <ClassicyTabs tabs={tabs} />;`, add:

```tsx
	// Appended last, after the conditional Password tab, so the destructive
	// actions always sit furthest from the tabs used routinely.
	tabs.push({ title: "Special", children: <SpecialTab /> });
```

- [ ] **Step 5: Run the full Account test suite**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/Account/`
Expected: PASS — all Account, ProfileEditor and SpecialTab tests.

- [ ] **Step 6: Run the repo checks**

```bash
pnpm --filter @rt911/frontend exec tsc -b
pnpm lint
pnpm test
```

Expected: all pass. If `tsc -b` reports nothing suspicious but you changed types, delete `packages/frontend/tsconfig.tsbuildinfo` and re-run — its incremental cache has masked real errors in this repo before.

- [ ] **Step 7: Commit**

```bash
git add packages/frontend/src/Applications/Account/ProfileEditor.tsx packages/frontend/src/Applications/Account/ProfileEditor.test.tsx
git commit -m "feat(account): show the Special tab in the profile editor"
```

---

### Task 5: Manual verification and deploy

**Files:** none — this task verifies Tasks 1–4 against a real environment.

**Interfaces:**
- Consumes: everything above.
- Produces: a verified deployment.

`packages/directus-extensions` has no test harness, so Task 1 is entirely unverified by CI. This task is where that risk gets retired. Do not skip it.

- [ ] **Step 1: Build and deploy the extension image first**

The frontend must never reach production before the routes exist. The extension ships inside a custom `rt911-api` image (`packages/directus-extensions/Dockerfile` — a `COPY` into `directus/directus:12.1.1`), built by CI on merge and rolled out by ArgoCD from the `Keeping-History/infra` repo.

Deployment is GitOps. Do **not** `kubectl set image` — `automated.selfHeal: true` reverts imperative edits within seconds.

- [ ] **Step 2: Set `RT911_APP_URL` on the API deployment**

Add `RT911_APP_URL=https://911realtime.org` to the `rt911-api` environment in the infra repo. Without it the code falls back to the same apex default, so this is belt-and-braces rather than load-bearing — but set it so staging can point elsewhere.

- [ ] **Step 3: Create a throwaway account that is actually representative**

Register a test account on `api-beta` and give it, at minimum:
- an **uploaded avatar** — this is the critical one. A fresh account with no avatar has nothing pointing at `directus_files.uploaded_by`, so it deletes cleanly *even if the blocking-reference step is missing entirely*. Testing without an avatar proves nothing.
- one playlist, one HyperCard stack, one personal Time Machine bookmark
- at least one IM Buddies message
- some desktop settings (move a window, change a TV channel)

- [ ] **Step 4: Record the before state**

```sql
SELECT 'playlists', count(*) FROM playlists WHERE user_created = :id
UNION ALL SELECT 'stacks', count(*) FROM stacks WHERE user_created = :id
UNION ALL SELECT 'bookmarks', count(*) FROM tm_bookmarks_personal WHERE user_created = :id
UNION ALL SELECT 'chat_messages', count(*) FROM chat_messages WHERE "user" = :id
UNION ALL SELECT 'chat_blocks', count(*) FROM chat_blocks WHERE "user" = :id
UNION ALL SELECT 'files', count(*) FROM directus_files WHERE uploaded_by = :id;
```

- [ ] **Step 5: Exercise "Delete my data" and verify**

Expected after: playlists/stacks/bookmarks/chat_messages all `0`; **`chat_blocks` unchanged**; `directus_files` count unchanged and the avatar still loads from its URL; the `directus_users` row still present with every profile field `NULL` except `email`; the desktop reloaded with default settings; **still signed in**.

- [ ] **Step 6: Exercise "Delete my account" and verify**

Use a second throwaway account, again with an avatar. Expected after: the `directus_users` row is gone; the browser lands on the signed-out desktop; the avatar file **still exists** in `directus_files` with `uploaded_by` now `NULL`; `chat_blocks` rows survive, orphaned.

If the delete returns 500 with a foreign-key violation, the `BLOCKING_REFS` loop is not running or is missing a table — check the API pod logs for the constraint name in the error, and add that table/column to `BLOCKING_REFS`.

- [ ] **Step 7: Confirm the email-change link still works**

Regression check on the `CONFIRM_BASE_URL` change: request an email change from a third test account and confirm the delivered link points at `https://911realtime.org/?confirm-email=…`, not the beta subdomain, and that opening it completes the change.

- [ ] **Step 8: Open the PR**

```bash
git push -u origin worktree-account-special-tab
gh pr create --title "feat(account): Special tab — delete my data / delete my account" --body "..."
```

Note in the PR body that the extension image must roll out before the frontend.

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Special tab with two buttons | 3, 4 |
| Delete-data scope (profile, settings, playlists, stacks, bookmarks, chat) | 1 (steps 2–4), 2 |
| Delete-account = data + user row | 1 (step 5) |
| Keep `directus_files` | 1 (BLOCKING_REFS nulls rather than deletes); verified 5.6 |
| Keep OpenReplay | untouched by every task — nothing references it |
| Keep `chat_blocks` | 1 (absent from erase); verified 5.5 |
| Risk-explaining alert on both | 3 |
| Typed confirm for account only | 3 |
| Quoted `"user"` column | 1 (knex query builder) |
| Blocking FK clearance | 1 (step 5) |
| localStorage keys + reload ordering | 2, 3 |
| `CONFIRM_BASE_URL` fix | 1 (step 1), verified 5.7 |
| Partial-failure response shape | 1, 2 |
| Deploy order | 5 |

**Placeholders:** none. The only `"..."` is the `gh pr create --body` argument, which is prose for the author to write.

**Type consistency:** `DeletionResult` is defined once in Task 2 and used verbatim in Task 3's mocks. `clearLocalSettings` / `reloadDesktop` / `deleteMyData` / `deleteMyAccount` keep the same names across Tasks 2, 3 and the test mocks. The server's `{deleted, failed}` shape in Task 1 matches `DeletionResult` exactly. `SETTINGS_KEYS` is `as const` in the implementation and consumed as `readonly string[]`.

**Known uncovered risk:** Task 1 has no automated test of any kind — `node --check` proves only that it parses. Task 5 is the whole of its verification.
