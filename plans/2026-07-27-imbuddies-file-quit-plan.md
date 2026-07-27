# IM Buddies File → Quit + Closable Buddy List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give IM Buddies' Sign On, Buddy List and Chat windows a File menu containing Quit, and make the Buddy List closable with a working way to reopen it.

**Architecture:** One `APP_MENU` constant defined in `IMBuddies.tsx` and threaded into three window components by prop, following the pattern TimeMachine already uses for four windows. The Buddy List gains `closable`, and the menu-bar extension's window-list items change from focus-only to open-then-focus so a closed window can come back. Get Info is excluded from the menu and declared a utility window.

**Tech Stack:** React 19 + TypeScript, `classicy` (external component library), vitest + @testing-library/react.

Design doc: `plans/2026-07-27-imbuddies-file-quit-design.md`. Read the "Resolved" section before starting — it explains why Get Info needs no menu of its own.

## Global Constraints

- **All work happens in `packages/frontend/src/Applications/IMBuddies/`.** Five files: `IMBuddies.tsx`, `SignOnWindow.tsx`, `BuddyListWindow.tsx`, `ChatWindow.tsx`, `InfoWindow.tsx`, plus their co-located tests.
- **Never write `vi.mock("classicy", () => ({...}))` in this app's window tests.** These components import many symbols from `classicy` (`ClassicyButton`, `ClassicyInput`, `ClassicyCheckbox`, `ClassicyPopUpMenu`, `useSoundDispatch`, …) and a wholesale factory drops every symbol it does not list, breaking the moment a component adds an import. Use the partial form these files already use:
  ```ts
  vi.mock("classicy", async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      ClassicyWindow: /* stub */,
  }))
  ```
- **`APP_ID` is `"IMBuddies.app"` and is redeclared in each window file** rather than imported. That is deliberate and documented in each file's comment; do not "fix" it.
- **No RTL auto-cleanup in this repo.** Every test file must call `afterEach(cleanup)` itself. All the files touched here already do.
- **The Buddy List window id is `"im_buddylist"`**, held in `BUDDY_LIST_WINDOW_ID` in `IMBuddies.tsx` and written literally as `id="im_buddylist"` in `BuddyListWindow.tsx`.
- Tests: `pnpm --filter @rt911/frontend exec vitest run src/Applications/IMBuddies/`. Full gate from repo root: `pnpm build && pnpm lint && pnpm test`.

## File Structure

**Modified — source:**
- `IMBuddies.tsx` — owns `APP_MENU` (new) and `revealWindow` (replaces `focusWindow`); passes `appMenu` to three windows.
- `SignOnWindow.tsx` — accepts and forwards `appMenu`.
- `BuddyListWindow.tsx` — accepts and forwards `appMenu`; `closable={false}` → `true`.
- `ChatWindow.tsx` — accepts and forwards `appMenu`.
- `InfoWindow.tsx` — adds `windowType="utility"`. No `appMenu`, deliberately.

**Modified — tests:** `SignOnWindow.test.tsx`, `BuddyListWindow.test.tsx`, `ChatWindow.test.tsx`, `InfoWindow.test.tsx`, `IMBuddies.test.tsx`.

No new files.

---

### Task 1: Define APP_MENU and give SignOnWindow a File menu

**Files:**
- Modify: `packages/frontend/src/Applications/IMBuddies/IMBuddies.tsx`
- Modify: `packages/frontend/src/Applications/IMBuddies/SignOnWindow.tsx`
- Test: `packages/frontend/src/Applications/IMBuddies/SignOnWindow.test.tsx`

**Interfaces:**
- Produces: `APP_MENU: ClassicyMenuItem[]` (module-level in `IMBuddies.tsx`, not exported), and the prop contract every window in Tasks 2–3 reuses:
  ```ts
  appMenu?: React.ComponentProps<typeof ClassicyWindow>["appMenu"];
  ```

`SignOnWindow` is done first because it is the simplest of the three — no props today, one `ClassicyWindow`.

- [ ] **Step 1: Write the failing test**

`SignOnWindow.test.tsx` currently uses a wholesale `vi.mock("classicy", () => ({...}))` at line 30. **Convert it to the partial form first**, then have the `ClassicyWindow` stub expose the menu. Replace the existing `vi.mock("classicy", ...)` block with:

```tsx
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	ClassicyWindow: (props: {
		children?: React.ReactNode;
		appMenu?: { id?: string; title?: string; menuChildren?: { id?: string; title?: string }[] }[];
	}) => (
		<div>
			{/* Flattened so a test can assert on the File menu and its items
			    without reaching into classicy's real menu rendering. */}
			{(props.appMenu ?? []).map((menu) => (
				<div key={menu.id} data-testid={`menu-${menu.id}`}>
					{menu.title}
					{(menu.menuChildren ?? []).map((item) => (
						<span key={item.id} data-testid={`menuitem-${item.id}`}>
							{item.title}
						</span>
					))}
				</div>
			))}
			{props.children}
		</div>
	),
	useAppManagerDispatch: () => () => {},
}));
```

Then add this test:

```tsx
describe("SignOnWindow File menu", () => {
	it("offers File -> Quit", () => {
		renderSignOn();
		const file = screen.getByTestId("menu-file");
		expect(file).toHaveTextContent("File");
		expect(within(file).getByText("Quit")).toBeInTheDocument();
	});
});
```

Add `within` to the `@testing-library/react` import if it is not already there.

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/IMBuddies/SignOnWindow.test.tsx`
Expected: FAIL — `Unable to find an element by: [data-testid="menu-file"]`, because nothing passes `appMenu` yet.

- [ ] **Step 3: Add APP_MENU in IMBuddies.tsx**

Insert after the `BUDDY_LIST_WINDOW_ID` declaration (currently line 36):

```tsx
/**
 * The File menu every non-utility IM Buddies window carries, so Quit is where
 * a Mac user reaches for it. Module-level rather than a useMemo: it closes
 * over nothing but module constants, so there is no dependency that could
 * change and no render it needs to be recomputed on.
 *
 * Quit also remains in the menu-bar extension below. That duplication is
 * deliberate — the tray item shipped first and users may already know it.
 */
const APP_MENU: ClassicyMenuItem[] = [
	{
		id: "file",
		title: "File",
		menuChildren: [quitMenuItemHelper(APP_ID, APP_NAME, appIcon)],
	},
];
```

`ClassicyMenuItem`, `quitMenuItemHelper`, `APP_ID`, `APP_NAME` and `appIcon` are all already imported or declared in this file — no import changes needed.

- [ ] **Step 4: Accept and forward the prop in SignOnWindow**

In `SignOnWindow.tsx`, change the component signature (line 51) from:

```tsx
export const SignOnWindow: React.FC = () => {
```

to:

```tsx
export const SignOnWindow: React.FC<{
	appMenu?: React.ComponentProps<typeof ClassicyWindow>["appMenu"];
}> = ({ appMenu }) => {
```

and add the prop to its `ClassicyWindow` (the element starting at line 98), after `collapsable={false}`:

```tsx
			appMenu={appMenu}
```

- [ ] **Step 5: Pass it from IMBuddies.tsx**

In `IMBuddiesContent`, change:

```tsx
			{!connected && <SignOnWindow />}
```

to:

```tsx
			{!connected && <SignOnWindow appMenu={APP_MENU} />}
```

- [ ] **Step 6: Run the test and verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/IMBuddies/SignOnWindow.test.tsx`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 7: Commit**

```bash
git add packages/frontend/src/Applications/IMBuddies/
git commit -m "feat(im-buddies): add a File menu with Quit to the Sign On window"
```

---

### Task 2: File menu on the Buddy List and Chat windows

**Files:**
- Modify: `packages/frontend/src/Applications/IMBuddies/BuddyListWindow.tsx:111`, `:145-155`
- Modify: `packages/frontend/src/Applications/IMBuddies/ChatWindow.tsx:66`, `:133-145`
- Modify: `packages/frontend/src/Applications/IMBuddies/IMBuddies.tsx`
- Test: `BuddyListWindow.test.tsx`, `ChatWindow.test.tsx`

**Interfaces:**
- Consumes: `APP_MENU` from Task 1, and the same `appMenu?: React.ComponentProps<typeof ClassicyWindow>["appMenu"]` prop shape.

Both test files already use the correct partial `vi.mock("classicy", async (importOriginal) => …)` form, so only their `ClassicyWindow` stubs need extending.

- [ ] **Step 1: Write the failing tests**

In `BuddyListWindow.test.tsx`, the `ClassicyWindow` stub is currently (line 69):

```tsx
	ClassicyWindow: (props: { children?: React.ReactNode }) => <div>{props.children}</div>,
```

Replace with:

```tsx
	ClassicyWindow: (props: {
		children?: React.ReactNode;
		closable?: boolean;
		appMenu?: { id?: string; title?: string; menuChildren?: { id?: string; title?: string }[] }[];
	}) => (
		<div data-closable={String(props.closable)}>
			{(props.appMenu ?? []).map((menu) => (
				<div key={menu.id} data-testid={`menu-${menu.id}`}>
					{menu.title}
					{(menu.menuChildren ?? []).map((item) => (
						<span key={item.id} data-testid={`menuitem-${item.id}`}>
							{item.title}
						</span>
					))}
				</div>
			))}
			{props.children}
		</div>
	),
```

`data-closable` is unused this task; Task 3 asserts on it.

Add the test:

```tsx
describe("BuddyListWindow File menu", () => {
	it("offers File -> Quit", () => {
		renderBuddyList();
		const file = screen.getByTestId("menu-file");
		expect(file).toHaveTextContent("File");
		expect(within(file).getByText("Quit")).toBeInTheDocument();
	});
});
```

In `ChatWindow.test.tsx`, apply the identical `ClassicyWindow` stub replacement (its current stub is at line 64's mock block), and add:

```tsx
describe("ChatWindow File menu", () => {
	it("offers File -> Quit", () => {
		renderChat();
		const file = screen.getByTestId("menu-file");
		expect(file).toHaveTextContent("File");
		expect(within(file).getByText("Quit")).toBeInTheDocument();
	});
});
```

Add `within` to the `@testing-library/react` imports in both files if absent. Use each file's existing render helper — `renderBuddyList()` and `renderChat()` — rather than calling `render` directly, since they set up the mocked provider state.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/IMBuddies/BuddyListWindow.test.tsx src/Applications/IMBuddies/ChatWindow.test.tsx`
Expected: FAIL in both — `Unable to find an element by: [data-testid="menu-file"]`.

- [ ] **Step 3: Accept and forward the prop in both components**

`BuddyListWindow.tsx` line 111, from:

```tsx
export const BuddyListWindow: React.FC = () => {
```

to:

```tsx
export const BuddyListWindow: React.FC<{
	appMenu?: React.ComponentProps<typeof ClassicyWindow>["appMenu"];
}> = ({ appMenu }) => {
```

and on its `ClassicyWindow` (line 146), after `initialPosition={["right", "top"]}`:

```tsx
			appMenu={appMenu}
```

`ChatWindow.tsx` line 66, from:

```tsx
export const ChatWindow: React.FC<{ profile: number; index?: number }> = ({ profile, index = 0 }) => {
```

to:

```tsx
export const ChatWindow: React.FC<{
	profile: number;
	index?: number;
	appMenu?: React.ComponentProps<typeof ClassicyWindow>["appMenu"];
}> = ({ profile, index = 0, appMenu }) => {
```

and on its `ClassicyWindow` (line 133), after `onCloseFunc={() => closeChat(profile)}`:

```tsx
			appMenu={appMenu}
```

- [ ] **Step 4: Pass APP_MENU from IMBuddies.tsx**

In `IMBuddiesContent`, change:

```tsx
					<BuddyListWindow />
					{openChats.map((profile, i) => (
						<ChatWindow key={profile} profile={profile} index={i} />
					))}
```

to:

```tsx
					<BuddyListWindow appMenu={APP_MENU} />
					{openChats.map((profile, i) => (
						<ChatWindow key={profile} profile={profile} index={i} appMenu={APP_MENU} />
					))}
```

Preserve the existing comment above the `ChatWindow` line explaining that `i` drives the cascade offset (#318).

- [ ] **Step 5: Run the tests and verify they pass**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/IMBuddies/`
Expected: PASS across the whole IM Buddies directory.

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/Applications/IMBuddies/
git commit -m "feat(im-buddies): add the File menu to the Buddy List and Chat windows"
```

---

### Task 3: Make the Buddy List closable, and able to come back

**Files:**
- Modify: `packages/frontend/src/Applications/IMBuddies/BuddyListWindow.tsx:150`
- Modify: `packages/frontend/src/Applications/IMBuddies/IMBuddies.tsx:60-68` (`focusWindow`)
- Modify: `packages/frontend/src/Applications/IMBuddies/InfoWindow.tsx:32`
- Test: `BuddyListWindow.test.tsx`, `InfoWindow.test.tsx`, `IMBuddies.test.tsx`

**Interfaces:**
- Consumes: `BUDDY_LIST_WINDOW_ID` (`"im_buddylist"`), already declared in `IMBuddies.tsx`.
- Produces: `revealWindow(windowId: string): void`, replacing `focusWindow`.

**This is the task that carries the real risk.** Setting `closable` alone is a one-word change that ships a trap: `ClassicyWindowClose` sets `closed: true`, `ClassicyWindowFocus` does **not** clear it, and the menu's *Buddy List* item dispatches Focus only. A user who closes the Buddy List would have no way back short of quitting — and no test would catch it, because the window cannot be closed today.

- [ ] **Step 1: Write the failing tests**

In `BuddyListWindow.test.tsx` (the stub from Task 2 already records `data-closable`):

```tsx
it("can be closed", () => {
	renderBuddyList();
	// The window is the only element carrying data-closable.
	expect(document.querySelector("[data-closable]")).toHaveAttribute("data-closable", "true");
});
```

In `InfoWindow.test.tsx`, extend its existing partial `ClassicyWindow` stub (line 27's mock block) to record the window type:

```tsx
	ClassicyWindow: (props: {
		children?: React.ReactNode;
		windowType?: string;
		appMenu?: unknown[];
	}) => (
		<div data-window-type={props.windowType} data-has-appmenu={String(Boolean(props.appMenu))}>
			{props.children}
		</div>
	),
```

and add:

```tsx
it("is a utility window and owns no menu", () => {
	renderInfo();
	const win = document.querySelector("[data-window-type]");
	// Utility: classicy skips these when choosing what to focus next, which is
	// what stops Get Info being auto-focused when the Buddy List closes.
	expect(win).toHaveAttribute("data-window-type", "utility");
	// Deliberately menu-less: classicy leaves the existing menu bar in place
	// for a window that supplies none, so File stays available.
	expect(win).toHaveAttribute("data-has-appmenu", "false");
});
```

In `IMBuddies.test.tsx`, add a dispatch spy to the classicy mock. Insert the hoisted spy near the other `vi.hoisted` declarations at the top:

```tsx
const mockDesktopDispatch = vi.hoisted(() => vi.fn());
```

and add this line inside the existing `vi.mock("classicy", ...)` factory (alongside `useAppManager` at line 178):

```tsx
	useAppManagerDispatch: () => mockDesktopDispatch,
```

Then add the regression test:

```tsx
describe("Buddy List menu item", () => {
	it("opens the window as well as focusing it, so a closed Buddy List can come back", async () => {
		mockDesktopDispatch.mockClear();
		renderApp({ connected: true });

		// Open the app's menu-bar extension, then choose Buddy List.
		fireEvent.click(screen.getByLabelText("Instant Messenger"));
		fireEvent.click(screen.getByText("Buddy List"));

		const types = mockDesktopDispatch.mock.calls.map(([a]) => a.type);
		// Focus alone is NOT enough: ClassicyWindowClose sets closed:true and
		// ClassicyWindowFocus does not clear it. Only ClassicyWindowOpen does.
		expect(types).toContain("ClassicyWindowOpen");
		expect(types).toContain("ClassicyWindowFocus");

		for (const call of mockDesktopDispatch.mock.calls) {
			if (call[0].type === "ClassicyWindowOpen" || call[0].type === "ClassicyWindowFocus") {
				expect(call[0].window.id).toBe("im_buddylist");
			}
		}
	});
});
```

Use whatever the file's existing render helper is named — the surrounding tests call `renderApp(...)`; match their argument shape for a connected session.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/IMBuddies/BuddyListWindow.test.tsx src/Applications/IMBuddies/InfoWindow.test.tsx src/Applications/IMBuddies/IMBuddies.test.tsx`
Expected: three failures — `data-closable` is `"false"`, `data-window-type` is `null`, and the dispatch list contains `ClassicyWindowFocus` but not `ClassicyWindowOpen`.

- [ ] **Step 3: Make the Buddy List closable**

`BuddyListWindow.tsx` line 150, change:

```tsx
			closable={false}
```

to:

```tsx
			closable={true}
```

- [ ] **Step 4: Replace focusWindow with revealWindow**

In `IMBuddies.tsx`, replace the `focusWindow` callback (lines 60-68):

```tsx
	const focusWindow = useCallback(
		(windowId: string) =>
			desktopEventDispatch({
				type: "ClassicyWindowFocus",
				app: { id: APP_ID },
				window: { id: windowId },
			}),
		[desktopEventDispatch],
	);
```

with:

```tsx
	// Open THEN focus. ClassicyWindowClose sets closed:true and
	// ClassicyWindowFocus does not clear it -- it only sets focus and the menu
	// bar -- so focusing a closed window does nothing visible. On a window that
	// already exists in state, ClassicyWindowOpen just sets closed:false, which
	// makes this safe for windows that were never closed. Without it, closing
	// the Buddy List would leave no way back except quitting.
	const revealWindow = useCallback(
		(windowId: string) => {
			desktopEventDispatch({
				type: "ClassicyWindowOpen",
				app: { id: APP_ID },
				window: { id: windowId },
			});
			desktopEventDispatch({
				type: "ClassicyWindowFocus",
				app: { id: APP_ID },
				window: { id: windowId },
			});
		},
		[desktopEventDispatch],
	);
```

Then update the two call sites and the dependency array inside `IMBuddiesMenus`:

- `onClickFunc: () => focusWindow(BUDDY_LIST_WINDOW_ID)` → `onClickFunc: () => revealWindow(BUDDY_LIST_WINDOW_ID)`
- `onClickFunc: () => focusWindow(\`im_chat_${profile}\`)` → `onClickFunc: () => revealWindow(\`im_chat_${profile}\`)`
- the `useMemo` dependency array ending `…, buddies, focusWindow]` → `…, buddies, revealWindow]`

Chat entries get the same treatment because "bring this window forward, opening it if closed" is what a Window menu means. Every window the list names is mounted, so `ClassicyWindowOpen` always finds an existing entry and only clears the closed flag — it never creates a phantom.

- [ ] **Step 5: Mark InfoWindow a utility window**

In `InfoWindow.tsx`, add to its `ClassicyWindow` (the element starting at line 32), after `collapsable={true}`:

```tsx
			windowType="utility"
```

Do **not** add an `appMenu` here. Classicy's focus reducer only assigns `Desktop.appMenu` when the focused window supplies a menu (`d && (…appMenu = d)`), so a menu-less Get Info leaves the previous window's File menu on screen — which is the behaviour we want.

- [ ] **Step 6: Run the tests and verify they pass**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/IMBuddies/`
Expected: PASS across the directory.

- [ ] **Step 7: Full gate**

Run from the repo root: `pnpm build && pnpm lint && pnpm test`
Expected: build succeeds, lint reports 0 errors (pre-existing warnings are fine), full suite passes.

- [ ] **Step 8: Commit**

```bash
git add packages/frontend/src/Applications/IMBuddies/
git commit -m "feat(im-buddies): make the Buddy List closable and reopenable"
```

---

### Task 4: Confirm in the running app

**Files:** none.

Two behaviours here were derived by reading classicy's reducer rather than observing it, and both are load-bearing. Confirm them against the real library.

- [ ] **Step 1: Start the dev server**

Run: `pnpm dev` (serves on `localhost:5173`; check nothing else already owns that port, or Vite will silently pick another and you will be testing a stale build).

- [ ] **Step 2: Check File → Quit on each window**

Open IM Buddies. With Sign On frontmost, confirm the menu bar shows **File** containing **Quit**, and that Quit closes the app. Reopen, sign on, and repeat with the Buddy List frontmost and with a Chat window frontmost.

- [ ] **Step 3: Check the menu bar survives Get Info**

With a buddy selected, choose **Get Info**. Confirm the File menu **stays on screen** while the Info window is frontmost.

This is the reducer-derived claim: `m2` guards its assignment (`d && (…appMenu = d)`), so a window with no menu should leave the menu bar untouched. If File disappears, stop and report it — do not resolve it by giving InfoWindow a menu, which the design explicitly excludes.

- [ ] **Step 4: Check close and reopen**

Close the Buddy List with its close box. Confirm you stay signed on and are not returned to Sign On. Then open the IM Buddies menu-bar extension and choose **Buddy List**; confirm the window comes back.

This is the trap Task 3 exists to prevent. If the window does not return, `ClassicyWindowOpen` is not reaching it — check the action's `window.id` matches `im_buddylist`.

- [ ] **Step 5: Report**

No commit. Report what passed, and anything that did not, before opening a PR.

---

## Self-review notes

Checked against the design:

- File → Quit on Sign On, Buddy List, Chat — Tasks 1 and 2.
- Get Info excluded from the menu — Task 3 Step 5, asserted negatively in Task 3 Step 1.
- Existing tray Quit retained — untouched; `IMBuddiesMenus` keeps `quitMenuItemHelper` at line 115.
- Module-level constant rather than `useMemo` — Task 1 Step 3, with the reasoning in the code comment.
- Buddy List closable, hides rather than signs off — Task 3 Step 3; no `onCloseFunc` is added, so nothing clears the session.
- Reopen path — Task 3 Step 4, with the regression test in Step 1.
- `windowType="utility"` on InfoWindow — Task 3 Step 5.
- Menu-bar-does-not-blank claim — verified in Task 4 Step 3.
