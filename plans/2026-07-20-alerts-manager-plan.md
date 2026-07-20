# Alerts Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An "Alerts Manager" control panel in the Apple menu (no desktop icon) with a single "Show Alerts" checkbox that enables/disables the Alerts extension's stream-driven modals.

**Architecture:** A ~30-line external store (`useSyncExternalStore` + `localStorage`) is the single source of truth for one boolean. The new `AlertsManager.app` (modeled on Classicy's `ClassicyDateAndTimeManager`) writes it; the existing `Alerts.tsx` extension reads it to gate both its `alerts`-channel subscription and its modal rendering. Spec: `plans/2026-07-20-alerts-manager-design.md`.

**Tech Stack:** React 19 + TypeScript + Vite, `classicy` component library, Vitest + Testing Library.

## Global Constraints

- Work in worktree `/home/robbiebyrd/rt911/.claude/worktrees/alerts-manager` (branch `feat/alerts-manager`, off `main`). All paths below are relative to `packages/frontend/` in that worktree unless noted.
- localStorage key: `rt911AlertsEnabled`. Default when absent/unreadable: **enabled (`true`)**. Only the literal string `"false"` means disabled.
- App identity: `APP_ID = "AlertsManager.app"`, `APP_NAME = "Alerts Manager"`, window `AlertsManager_1`. Checkbox label copy: **"Show Alerts"**.
- New test files MUST call `afterEach(cleanup)` — this project's Vitest has no RTL auto-cleanup.
- Never fully replace the `classicy` mock — always spread `importOriginal` and override only named components (full replacement breaks when a component adds imports).
- The pre-commit hook bumps `classicy` and stages `pnpm-lock.yaml`; a lockfile change riding along in commits is expected. Do not hand-edit the classicy version.
- Run tests from the worktree root with `pnpm --filter @rt911/frontend exec vitest run <path>`.

---

### Task 1: `alertsSettings` external store

**Files:**
- Create: `packages/frontend/src/Applications/Alerts/alertsSettings.ts`
- Test: `packages/frontend/src/Applications/Alerts/alertsSettings.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces (used by Tasks 2 & 3):
  - `getAlertsEnabled(): boolean`
  - `setAlertsEnabled(value: boolean): void`
  - `useAlertsEnabled(): boolean` (React hook)
  - `resetAlertsSettingsForTests(): void` — re-hydrates the module cache from `localStorage`; tests call it after mutating/clearing storage.

- [ ] **Step 1: One-time setup — install deps in the fresh worktree**

```bash
cd /home/robbiebyrd/rt911/.claude/worktrees/alerts-manager && pnpm install
```

Expected: completes without error (pnpm links the monorepo packages).

- [ ] **Step 2: Write the failing test**

Create `packages/frontend/src/Applications/Alerts/alertsSettings.test.ts`:

```ts
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getAlertsEnabled,
	resetAlertsSettingsForTests,
	setAlertsEnabled,
	useAlertsEnabled,
} from "./alertsSettings";

const KEY = "rt911AlertsEnabled";

afterEach(() => {
	vi.restoreAllMocks();
	window.localStorage.clear();
	resetAlertsSettingsForTests();
});

describe("alertsSettings store", () => {
	it("defaults to enabled when localStorage has no value", () => {
		expect(getAlertsEnabled()).toBe(true);
	});

	it("hydrates disabled state from a persisted \"false\"", () => {
		window.localStorage.setItem(KEY, "false");
		resetAlertsSettingsForTests();
		expect(getAlertsEnabled()).toBe(false);
	});

	it("treats any value other than the literal \"false\" as enabled", () => {
		window.localStorage.setItem(KEY, "garbage");
		resetAlertsSettingsForTests();
		expect(getAlertsEnabled()).toBe(true);
	});

	it("setAlertsEnabled persists to localStorage and updates the getter", () => {
		setAlertsEnabled(false);
		expect(getAlertsEnabled()).toBe(false);
		expect(window.localStorage.getItem(KEY)).toBe("false");

		setAlertsEnabled(true);
		expect(getAlertsEnabled()).toBe(true);
		expect(window.localStorage.getItem(KEY)).toBe("true");
	});

	it("useAlertsEnabled re-renders subscribers when the flag flips", () => {
		const { result } = renderHook(() => useAlertsEnabled());
		expect(result.current).toBe(true);

		act(() => setAlertsEnabled(false));
		expect(result.current).toBe(false);

		act(() => setAlertsEnabled(true));
		expect(result.current).toBe(true);
	});

	it("falls back to enabled when localStorage reads throw (private-mode Safari)", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("denied");
		});
		resetAlertsSettingsForTests();
		expect(getAlertsEnabled()).toBe(true);
	});

	it("keeps working in-memory when localStorage writes throw", () => {
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("denied");
		});
		setAlertsEnabled(false);
		expect(getAlertsEnabled()).toBe(false);
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd /home/robbiebyrd/rt911/.claude/worktrees/alerts-manager && pnpm --filter @rt911/frontend exec vitest run src/Applications/Alerts/alertsSettings.test.ts
```

Expected: FAIL — cannot resolve `./alertsSettings`.

- [ ] **Step 4: Write the implementation**

Create `packages/frontend/src/Applications/Alerts/alertsSettings.ts`:

```ts
import { useSyncExternalStore } from "react";

/**
 * Desktop-wide "show alerts" preference, written by the Alerts Manager control
 * panel and read by the Alerts extension. Lives outside React (plus a
 * localStorage mirror) because the two apps mount independently under
 * ClassicyDesktop with no shared ancestor that owns this state.
 */
const STORAGE_KEY = "rt911AlertsEnabled";

const readStored = (): boolean => {
	try {
		return window.localStorage.getItem(STORAGE_KEY) !== "false";
	} catch {
		return true;
	}
};

let enabled = readStored();
const listeners = new Set<() => void>();

export const getAlertsEnabled = (): boolean => enabled;

export const setAlertsEnabled = (value: boolean): void => {
	if (enabled === value) return;
	enabled = value;
	try {
		window.localStorage.setItem(STORAGE_KEY, String(value));
	} catch {
		// Storage unavailable (private-mode Safari): setting is session-only.
	}
	for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

export const useAlertsEnabled = (): boolean =>
	useSyncExternalStore(subscribe, getAlertsEnabled);

/** Test-only: re-hydrate the module cache after tests mutate localStorage. */
export const resetAlertsSettingsForTests = (): void => {
	enabled = readStored();
};
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd /home/robbiebyrd/rt911/.claude/worktrees/alerts-manager && pnpm --filter @rt911/frontend exec vitest run src/Applications/Alerts/alertsSettings.test.ts
```

Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
cd /home/robbiebyrd/rt911/.claude/worktrees/alerts-manager && git add packages/frontend/src/Applications/Alerts/alertsSettings.ts packages/frontend/src/Applications/Alerts/alertsSettings.test.ts && git commit -m "feat(alerts): persisted alertsEnabled external store

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Gate the Alerts extension on the flag

**Files:**
- Modify: `packages/frontend/src/Applications/Alerts/Alerts.tsx` (subscribe effect ~lines 38-42; render gate ~line 71)
- Test: `packages/frontend/src/Applications/Alerts/Alerts.test.tsx` (extend)

**Interfaces:**
- Consumes: `useAlertsEnabled()`, and in tests `setAlertsEnabled(value)` / `resetAlertsSettingsForTests()` from Task 1.
- Produces: behavior only — no exports change.

- [ ] **Step 1: Write the failing tests**

In `packages/frontend/src/Applications/Alerts/Alerts.test.tsx`, add the store import after the existing `MediaStreamContext` import (line 5):

```ts
import {
	resetAlertsSettingsForTests,
	setAlertsEnabled,
} from "./alertsSettings";
```

Extend the existing `afterEach` (lines 54-57) to reset the store:

```ts
afterEach(() => {
	cleanup();
	mockAppRunning.value = true;
	window.localStorage.clear();
	resetAlertsSettingsForTests();
});
```

Add `act` to the existing `@testing-library/react` import on line 1:

```ts
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
```

Append a new describe block at the end of the file:

```tsx
describe("Alerts extension: enabled/disabled gating", () => {
	it("does not subscribe or render a modal while alerts are disabled", () => {
		setAlertsEnabled(false);
		const { subscribeAlerts } = renderWithAlerts([
			mk(1, "Suppressed", "2001-09-11T12:40:00Z"),
		]);
		expect(subscribeAlerts).not.toHaveBeenCalled();
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("hides a visible modal and unsubscribes the moment alerts are disabled", () => {
		const { subscribeAlerts, unsubscribeAlerts } = renderWithAlerts([
			mk(1, "Visible", "2001-09-11T12:40:00Z"),
		]);
		expect(subscribeAlerts).toHaveBeenCalledWith("Alerts.app");
		expect(screen.getByRole("alertdialog")).not.toBeNull();

		act(() => setAlertsEnabled(false));
		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(unsubscribeAlerts).toHaveBeenCalledWith("Alerts.app");
	});

	it("re-subscribes when alerts are re-enabled", () => {
		const { subscribeAlerts } = renderWithAlerts([]);
		expect(subscribeAlerts).toHaveBeenCalledTimes(1);

		act(() => setAlertsEnabled(false));
		act(() => setAlertsEnabled(true));
		expect(subscribeAlerts).toHaveBeenCalledTimes(2);
	});
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

```bash
cd /home/robbiebyrd/rt911/.claude/worktrees/alerts-manager && pnpm --filter @rt911/frontend exec vitest run src/Applications/Alerts/Alerts.test.tsx
```

Expected: the 6 pre-existing tests PASS; the 3 new tests FAIL (subscribe called / modal rendered despite disabled).

- [ ] **Step 3: Implement the gate**

In `packages/frontend/src/Applications/Alerts/Alerts.tsx`:

Add the import after the `MediaStreamContext` import block (line 7):

```ts
import { useAlertsEnabled } from "./alertsSettings";
```

Read the flag next to the existing `isRunning` selector (after line 30):

```ts
const enabled = useAlertsEnabled();
```

Replace the subscribe effect (lines 38-42) — disabling runs the cleanup, and
`unsubscribeAlerts` as the last subscriber unsubscribes the WS channel and
clears the un-revealed buffer (`MediaStreamProvider.tsx:484-487`), so alerts
that fire while off are skipped (fire-on-cross channel, no snapshot):

```ts
// The extension is always mounted; subscribe while the app entry exists AND
// the user hasn't turned alerts off in the Alerts Manager control panel.
useEffect(() => {
	if (!isRunning || !enabled) return;
	subscribeAlerts(appId);
	return () => unsubscribeAlerts(appId);
}, [isRunning, enabled, subscribeAlerts, unsubscribeAlerts]);
```

Gate the modal render (line 71) — change:

```tsx
{current && (
```

to:

```tsx
{enabled && current && (
```

- [ ] **Step 4: Run tests to verify all pass**

```bash
cd /home/robbiebyrd/rt911/.claude/worktrees/alerts-manager && pnpm --filter @rt911/frontend exec vitest run src/Applications/Alerts/Alerts.test.tsx
```

Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/robbiebyrd/rt911/.claude/worktrees/alerts-manager && git add packages/frontend/src/Applications/Alerts/Alerts.tsx packages/frontend/src/Applications/Alerts/Alerts.test.tsx && git commit -m "feat(alerts): gate extension subscription and modal on alertsEnabled

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Alerts Manager app + Desktop mount

**Files:**
- Create: `packages/frontend/src/Applications/Alerts/AlertsManager.tsx`
- Modify: `packages/frontend/src/Desktop.tsx` (imports ~line 10, JSX ~line 29)
- Test: `packages/frontend/src/Applications/Alerts/AlertsManager.test.tsx`

**Interfaces:**
- Consumes: `useAlertsEnabled()` / `setAlertsEnabled(value)` from Task 1; classicy exports `ClassicyApp`, `ClassicyWindow`, `ClassicyButton`, `ClassicyCheckbox`, `ClassicyControlGroup`, `ClassicyIcons`, `useAppManagerDispatch`, `useClassicyAboutMenu`, `useClassicyWindowClose`, `closeWindowMenuItemHelper`, `quitAppHelper`, `quitMenuItemHelper` (all verified exported from the package index).
- Produces: `export const AlertsManager: React.FC` (mounted in `Desktop.tsx`).

- [ ] **Step 1: Write the failing test**

Create `packages/frontend/src/Applications/Alerts/AlertsManager.test.tsx`.
ClassicyApp/ClassicyWindow are replaced with prop-capturing pass-throughs
(their real implementations need the full desktop context); the menu hooks are
stubbed for the same reason. `ClassicyCheckbox`/`ClassicyControlGroup`/
`ClassicyButton` render for real — `useClassicyAnalytics` inside the checkbox
no-ops without a provider.

```tsx
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Captures the props ClassicyApp is rendered with so the test can assert the
// Apple-menu/no-desktop-icon contract without classicy's desktop chrome.
const appProps = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	ClassicyApp: ({
		children,
		...props
	}: { children?: React.ReactNode } & Record<string, unknown>) => {
		appProps.current = props;
		return <div>{children}</div>;
	},
	ClassicyWindow: ({ children }: { children?: React.ReactNode }) => (
		<div>{children}</div>
	),
	useAppManagerDispatch: () => vi.fn(),
	useClassicyAboutMenu: () => ({
		aboutMenuItem: { id: "about" },
		aboutWindow: null,
	}),
	useClassicyWindowClose: () => vi.fn(),
}));

import { AlertsManager } from "./AlertsManager";
import { getAlertsEnabled, resetAlertsSettingsForTests, setAlertsEnabled } from "./alertsSettings";

afterEach(() => {
	cleanup();
	window.localStorage.clear();
	resetAlertsSettingsForTests();
});

describe("Alerts Manager control panel", () => {
	it("registers as an Apple-menu app with no desktop icon", () => {
		render(<AlertsManager />);
		expect(appProps.current.id).toBe("AlertsManager.app");
		expect(appProps.current.noDesktopIcon).toBe(true);
		expect(appProps.current.addSystemMenu).toBe(true);
	});

	it("shows the checkbox checked while alerts are enabled", () => {
		render(<AlertsManager />);
		const checkbox = screen.getByLabelText("Show Alerts") as HTMLInputElement;
		expect(checkbox.checked).toBe(true);
	});

	it("reflects a persisted disabled state", () => {
		setAlertsEnabled(false);
		render(<AlertsManager />);
		const checkbox = screen.getByLabelText("Show Alerts") as HTMLInputElement;
		expect(checkbox.checked).toBe(false);
	});

	it("toggling the checkbox flips and persists the store", () => {
		render(<AlertsManager />);
		const checkbox = screen.getByLabelText("Show Alerts");

		act(() => {
			fireEvent.click(checkbox);
		});
		expect(getAlertsEnabled()).toBe(false);
		expect(window.localStorage.getItem("rt911AlertsEnabled")).toBe("false");

		act(() => {
			fireEvent.click(checkbox);
		});
		expect(getAlertsEnabled()).toBe(true);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/robbiebyrd/rt911/.claude/worktrees/alerts-manager && pnpm --filter @rt911/frontend exec vitest run src/Applications/Alerts/AlertsManager.test.tsx
```

Expected: FAIL — cannot resolve `./AlertsManager`.

- [ ] **Step 3: Write the component**

Create `packages/frontend/src/Applications/Alerts/AlertsManager.tsx`.
Structure mirrors classicy's `ClassicyDateAndTimeManager` (the Apple-menu
control-panel idiom: `noDesktopIcon` + `addSystemMenu`). No Edit menu — this
panel has no text-entry fields. The icon is the same bundled warning icon the
Alerts extension declares, tying the pair together in the Apple menu / About
window (the only places it renders).

```tsx
import {
	ClassicyApp,
	ClassicyButton,
	ClassicyCheckbox,
	ClassicyControlGroup,
	ClassicyIcons,
	ClassicyWindow,
	closeWindowMenuItemHelper,
	quitAppHelper,
	quitMenuItemHelper,
	useAppManagerDispatch,
	useClassicyAboutMenu,
	useClassicyWindowClose,
} from "classicy";
import type React from "react";
import { setAlertsEnabled, useAlertsEnabled } from "./alertsSettings";

const APP_ID = "AlertsManager.app";
const APP_NAME = "Alerts Manager";
const WINDOW_ID = "AlertsManager_1";
const appIcon = ClassicyIcons.applications.internetExplorer
	.documentWarning as string;

/**
 * Control panel for the Alerts extension: an Apple-menu app (no desktop icon)
 * whose single checkbox writes the shared alertsSettings store. While off, the
 * extension unsubscribes from the alerts channel entirely — alerts whose
 * moment passes are skipped, not queued (see the design doc,
 * plans/2026-07-20-alerts-manager-design.md).
 */
export const AlertsManager: React.FC = () => {
	const enabled = useAlertsEnabled();
	const desktopEventDispatch = useAppManagerDispatch();

	const { aboutMenuItem, aboutWindow } = useClassicyAboutMenu(
		APP_ID,
		APP_NAME,
		appIcon,
	);
	const windowClose = useClassicyWindowClose(APP_ID);

	const quitApp = () => {
		desktopEventDispatch(quitAppHelper(APP_ID, APP_NAME, appIcon));
	};

	// Mac OS 8 HIG control-panel menu bar. The About entry is discovery data:
	// ClassicyDesktopMenuBar hoists it into the Apple menu and strips it from
	// this menu before rendering. No Edit menu — there are no entry fields.
	const appMenu = [
		{
			id: `${APP_ID}_file`,
			title: "File",
			menuChildren: [
				{ ...aboutMenuItem, title: `About ${APP_NAME}` },
				{
					...closeWindowMenuItemHelper(`${APP_ID}_close_window`, () =>
						windowClose(WINDOW_ID, quitAppHelper(APP_ID, APP_NAME, appIcon)),
					),
					keyboardShortcut: "⌥W",
				},
				{ id: "spacer" },
				{
					...quitMenuItemHelper(APP_ID, APP_NAME, appIcon),
					keyboardShortcut: "⌥Q",
				},
			],
		},
	];

	return (
		<ClassicyApp
			id={APP_ID}
			name={APP_NAME}
			icon={appIcon}
			defaultWindow={WINDOW_ID}
			noDesktopIcon={true}
			addSystemMenu={true}
		>
			<ClassicyWindow
				id={WINDOW_ID}
				title={APP_NAME}
				appId={APP_ID}
				icon={appIcon}
				closable={true}
				resizable={false}
				zoomable={false}
				scrollable={false}
				collapsable={false}
				initialSize={[280, 130]}
				initialPosition={[320, 80]}
				modal={false}
				appMenu={appMenu}
			>
				<ClassicyControlGroup label={"Alerts"}>
					<ClassicyCheckbox
						id={"show_alerts"}
						label={"Show Alerts"}
						checked={enabled}
						onClickFunc={(checked: boolean) => setAlertsEnabled(checked)}
					/>
				</ClassicyControlGroup>
				<ClassicyButton isDefault={false} onClickFunc={quitApp}>
					Quit
				</ClassicyButton>
			</ClassicyWindow>
			{aboutWindow}
		</ClassicyApp>
	);
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /home/robbiebyrd/rt911/.claude/worktrees/alerts-manager && pnpm --filter @rt911/frontend exec vitest run src/Applications/Alerts/AlertsManager.test.tsx
```

Expected: PASS (4 tests). If `getByLabelText` fails because `ClassicyControlLabel` renders the label without an htmlFor association in this version, switch the queries to `container.querySelector('input#show_alerts')` — do not weaken the assertions.

- [ ] **Step 5: Mount in Desktop.tsx**

In `packages/frontend/src/Desktop.tsx`, add the import directly under the `Alerts` import (line 10):

```ts
import { AlertsManager } from "./Applications/Alerts/AlertsManager";
```

and mount it directly under `<Alerts />` (line 29):

```tsx
			<Alerts />
			<AlertsManager />
```

- [ ] **Step 6: Commit**

```bash
cd /home/robbiebyrd/rt911/.claude/worktrees/alerts-manager && git add packages/frontend/src/Applications/Alerts/AlertsManager.tsx packages/frontend/src/Applications/Alerts/AlertsManager.test.tsx packages/frontend/src/Desktop.tsx && git commit -m "feat(alerts): Alerts Manager control panel in the Apple menu

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Full verification

**Files:** none new.

**Interfaces:** n/a — runs the same checks CI requires (`tsc -b`, `eslint .`, `vitest run`).

- [ ] **Step 1: Run the full frontend check suite**

```bash
cd /home/robbiebyrd/rt911/.claude/worktrees/alerts-manager && pnpm build && pnpm lint && pnpm test
```

Expected: `tsc -b && vite build` succeeds, eslint clean, all vitest suites pass (baseline on main was green; only the three Alerts suites changed).

- [ ] **Step 2: Fix anything that fails, re-run until green, then commit any fixes**

If all three commands passed with no changes, skip the commit. Otherwise:

```bash
cd /home/robbiebyrd/rt911/.claude/worktrees/alerts-manager && git add -A && git commit -m "fix(alerts): verification fixes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
