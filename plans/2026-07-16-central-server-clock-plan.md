# Central Server Clock ("Forced Clock Mode") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator can force every connected client onto one authoritative server clock via a key-guarded REST API on the streamer; while forced, clients can't change date/time (Time Machine disabled, Date & Time editors locked) but can still change their display-only timezone.

**Architecture:** A Redis-persisted `MasterClock` (two-anchor math: `VirtualAt + (now − WallAt)`) lives in a new `internal/clock` package, wired into the Hub. REST `POST/GET /clock` mutates it; changes broadcast a msgpack `clock` frame to every session and enrich `heartbeat_ack` with `master_time`. The server clamps client-supplied times on `init`/`seek`/`heartbeat` while active. The frontend obeys via the sanctioned `setDateTimeFromUtc` seam and enforces UI locks reactively (PlaylistProvider `disabledApps` precedent); classicy gains a `dateTimeLocked` flag its Date & Time Manager respects.

**Tech Stack:** Go 1.25 (`classicy/streamer` module, go-redis v9, msgpack v5, miniredis for tests), React 19 + TypeScript (Vite/vitest), classicy (zustand store, external repo `~/classicy`, auto-published on push to main).

**Spec:** `plans/2026-07-16-central-server-clock-design.md` (approved).

## Global Constraints

- **Wire rule:** server→client is binary msgpack (`outMsg` via `send_`/`encodeMsg`), client→server stays JSON text. Both sides of the wire change land in the same PR; protocol doc updated in the same PR.
- **Never block the Hub; `send_` stays non-blocking; hold `Session.mu` for the shortest window** (backend CLAUDE.md hard rules).
- **Frontend clock writes go only through `setDateTimeFromUtc(setDateTime, iso)`** — no new ad-hoc `setDateTime` call sites outside the provider seam added here.
- **Auth:** `X-Clock-Key` header, `crypto/subtle.ConstantTimeCompare`, key from `CLOCK_CONTROL_KEY` env; unset key ⇒ `/clock` returns 404 for all verbs.
- **Redis names:** key `clock:master`, pub/sub channel `clock:master:changed`.
- **Wire names:** message type `"clock"` (`{active, time?}`), `heartbeat_ack.master_time` (optional, present only while forced).
- **Frontend drift threshold:** `FORCED_DRIFT_THRESHOLD_MS = 2_000`.
- **Timezone stays editable everywhere** — it is display-only (`virtualUtcMs` strips it); nothing in this feature may touch `timeZoneOffset` handling.
- **Backend tests:** colocated `_test.go`, miniredis for Redis, `newTestSession`/`recvType` helpers in `internal/session/session_test.go`.
- **Frontend tests:** colocated, `afterEach(cleanup)`, FakeWebSocket + msgpack `frame()` harness from `MediaStreamProvider.weather.test.tsx`.
- **Repos:** rt911 work happens on `feat/flight-map-controls` (this worktree); classicy work in `~/classicy` (push to main auto-bumps + publishes); infra snippet is a documented follow-up in `~/infra`.
- Paths below are relative to the rt911 repo root unless prefixed `~/classicy` or `~/infra`.

---

### Task 0: Sync the worktree branch with main

The frontend tasks build on `PlaylistProvider` and the auth/playlist code that exists only on main (branch is ~58 commits behind).

**Files:** none (git only).

- [ ] **Step 1: Merge origin/main**

```bash
cd /home/robbiebyrd/rt911/.claude/worktrees/flight-map-controls
git fetch origin && git merge origin/main --no-edit
```

Expected: clean merge (main already contains this branch's commits). If the user's uncommitted `FlightTracker.tsx` edit conflicts, STOP and ask — do not stash their work.

- [ ] **Step 2: Verify gates on the merged tree**

```bash
pnpm install
pnpm --filter @rt911/frontend exec tsc -b && pnpm test 2>&1 | tail -3
cd packages/backend && go test ./... 2>&1 | tail -3
```

Expected: all green (a `FlightTracker.test.tsx` failure is expected ONLY if the user's uncommitted worktree edit is still present — confirm via `git status` before blaming the merge).

---

### Task 1: classicy — `dateTimeLocked` state + lock/unlock actions

**Files (in `~/classicy`):**
- Modify: `src/SystemFolder/ControlPanels/AppManager/ClassicyAppManager.ts` (interface + default seed)
- Modify: `src/SystemFolder/ControlPanels/DateAndTimeManager/ClassicyDateAndTimeEventHandler.ts`
- Test: `src/SystemFolder/ControlPanels/DateAndTimeManager/ClassicyDateTimeManagerEventHandler.test.ts` (extend)

**Interfaces:**
- Consumes: existing `classicyDateTimeManagerEventHandler(ds, action)` and the `ClassicyManagerDateTime` prefix routing in `ClassicyAppManager.ts`.
- Produces: `ClassicyStoreSystemDateAndTimeManager.dateTimeLocked: boolean` (default `false`); action types `"ClassicyManagerDateTimeLock"` / `"ClassicyManagerDateTimeUnlock"`. **The reducer must NOT block `ClassicyManagerDateTimeSet` while locked** — the rt911 provider's forced corrections arrive through that same action; the lock is a UI-editor flag only.

- [ ] **Step 1: Write the failing tests**

Append to `ClassicyDateTimeManagerEventHandler.test.ts` (reuse the file's existing `makeStore()` helper; extend its overrides type with `dateTimeLocked?: boolean` and seed `dateTimeLocked: false` in the DateAndTime block):

```ts
describe("classicyDateTimeManagerEventHandler — ClassicyManagerDateTimeLock/Unlock", () => {
	it("sets dateTimeLocked on Lock", () => {
		const ds = makeStore();
		classicyDateTimeManagerEventHandler(ds, { type: "ClassicyManagerDateTimeLock" });
		expect(ds.System.Manager.DateAndTime.dateTimeLocked).toBe(true);
	});

	it("clears dateTimeLocked on Unlock", () => {
		const ds = makeStore({ dateTimeLocked: true });
		classicyDateTimeManagerEventHandler(ds, { type: "ClassicyManagerDateTimeUnlock" });
		expect(ds.System.Manager.DateAndTime.dateTimeLocked).toBe(false);
	});

	it("still applies DateTimeSet while locked (lock is a UI flag, not a write guard)", () => {
		const ds = makeStore({ dateTimeLocked: true });
		const date = new Date("2024-06-15T12:00:00.000Z");
		classicyDateTimeManagerEventHandler(ds, {
			type: "ClassicyManagerDateTimeSet",
			dateTime: date,
		});
		expect(ds.System.Manager.DateAndTime.dateTime).toBe(date.toISOString());
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/classicy && pnpm test 2>&1 | tail -10`
Expected: the two new Lock/Unlock tests FAIL (state unchanged / TS error on `dateTimeLocked`); the Set-while-locked test may pass already.

- [ ] **Step 3: Add the state field, default, and reducer cases**

In `ClassicyAppManager.ts`, add to `ClassicyStoreSystemDateAndTimeManager` (after `boundaryLocked: boolean;`):

```ts
	/** When true, the Date & Time Manager's date/time editors are disabled
	 *  (timezone stays editable). Set by the host app, e.g. while a server
	 *  forces the clock. Not a write guard — DateTimeSet still applies. */
	dateTimeLocked: boolean;
```

In `DefaultAppManagerState`'s `DateAndTime` block (after `boundaryLocked: false,`):

```ts
    dateTimeLocked: false,
```

In `ClassicyDateAndTimeEventHandler.ts`, add two cases to the action-type switch, mirroring the exact mutation/return idiom of the existing `"ClassicyManagerDateTimePause"` case (mutate `ds.System.Manager.DateAndTime` the same way it does):

```ts
case "ClassicyManagerDateTimeLock": {
	ds.System.Manager.DateAndTime.dateTimeLocked = true;
	break;
}
case "ClassicyManagerDateTimeUnlock": {
	ds.System.Manager.DateAndTime.dateTimeLocked = false;
	break;
}
```

(No routing change needed — the `action.type.startsWith("ClassicyManagerDateTime")` prefix router already delivers these.)

Also add `dateTimeLocked: false` to any test fixtures that build a full `DateAndTime` state and now fail typecheck (the agent survey found such fixtures in Finder/MoviePlayer/PictureViewer/PDFViewer tests).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/classicy && pnpm test 2>&1 | tail -5`
Expected: PASS, including the pre-existing suite.

- [ ] **Step 5: Commit (do not push yet — Task 2 rides the same release)**

```bash
cd ~/classicy && git add -A && git commit -m "feat(date-time): dateTimeLocked flag + Lock/Unlock actions"
```

---

### Task 2: classicy — Date & Time Manager respects the lock; publish release

**Files (in `~/classicy`):**
- Modify: `src/SystemFolder/ControlPanels/DateAndTimeManager/ClassicyDateAndTimeManager.tsx`
- Test: `src/SystemFolder/ControlPanels/DateAndTimeManager/ClassicyDateAndTimeManager.test.tsx` (new)

**Interfaces:**
- Consumes: `dateTimeLocked` from Task 1; `ClassicyDatePicker`/`ClassicyTimePicker` `disabled?: boolean` props (already exist); `ClassicyPopUpMenu` has no `disabled` prop — timezone stays enabled with zero changes.
- Produces: the published classicy release rt911 Tasks 7–9 build against.

- [ ] **Step 1: Write the failing component test**

Create `ClassicyDateAndTimeManager.test.tsx` next to the component. It drives the real zustand store via the exported `dispatch` (pattern: `ClassicyCheckbox.test.tsx` for render conventions):

```tsx
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { dispatch } from "@/SystemFolder/ControlPanels/AppManager/ClassicyAppManagerUtils";
import { ClassicyDateAndTimeManager } from "./ClassicyDateAndTimeManager";

afterEach(() => {
	dispatch({ type: "ClassicyManagerDateTimeUnlock" });
	cleanup();
});

describe("ClassicyDateAndTimeManager — dateTimeLocked", () => {
	it("disables the date and time editors but not the timezone picker when locked", () => {
		dispatch({ type: "ClassicyManagerDateTimeLock" });
		const { container } = render(<ClassicyDateAndTimeManager />);

		const dateColumn = container.querySelector(".classicyDateAndTimeManagerDateColumn");
		const timeColumn = container.querySelector(".classicyDateAndTimeManagerTimeColumn");
		for (const col of [dateColumn, timeColumn]) {
			const inputs = col?.querySelectorAll("input") ?? [];
			expect(inputs.length).toBeGreaterThan(0);
			for (const input of inputs) expect((input as HTMLInputElement).disabled).toBe(true);
		}

		const tzSelect = container.querySelector("select") as HTMLSelectElement;
		expect(tzSelect).not.toBeNull();
		expect(tzSelect.disabled).toBe(false);
	});

	it("editors are enabled when not locked", () => {
		const { container } = render(<ClassicyDateAndTimeManager />);
		const anyDisabled = [...container.querySelectorAll("input")].some((i) => i.disabled);
		expect(anyDisabled).toBe(false);
	});
});
```

(If the component's export name or a required prop differs, mirror how an existing story/test mounts it — adjust the mount, not the assertions.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/classicy && pnpm test 2>&1 | tail -10`
Expected: FAIL — inputs not disabled when locked.

- [ ] **Step 3: Pass `disabled` to both pickers**

In `ClassicyDateAndTimeManager.tsx` (the component already reads `dateAndTimeState` via `useAppManager((state) => state.System.Manager.DateAndTime)`), add the prop to both editors:

```tsx
<ClassicyDatePicker
	id={"date"}
	labelTitle={""}
	prefillValue={date}
	onChangeFunc={updateSystemDate}
	minValue={minValue}
	maxValue={maxValue}
	disabled={dateAndTimeState.dateTimeLocked}
></ClassicyDatePicker>
```

```tsx
<ClassicyTimePicker
	id={"time"}
	labelTitle={""}
	labelPosition="left"
	onChangeFunc={updateSystemTime}
	prefillValue={date}
	minValue={minValue}
	maxValue={maxValue}
	disabled={dateAndTimeState.dateTimeLocked}
></ClassicyTimePicker>
```

The timezone `<ClassicyPopUpMenu>` is untouched.

- [ ] **Step 4: Run tests, then build**

Run: `cd ~/classicy && pnpm test && pnpm build`
Expected: PASS + clean build.

- [ ] **Step 5: Commit, push, verify the npm release**

```bash
cd ~/classicy
git add -A && git commit -m "feat(date-time): disable date/time editors when dateTimeLocked (tz stays editable)"
git push origin main
```

CI auto-bumps the patch version and publishes. Wait for it, then verify (current version is 0.38.x; expect a bump):

```bash
sleep 180 && npm view classicy version
```

Expected: a version newer than the one in rt911's `pnpm-lock.yaml`. Then pull it into rt911:

```bash
cd /home/robbiebyrd/rt911/.claude/worktrees/flight-map-controls
pnpm update classicy --latest --recursive
pnpm --filter @rt911/frontend exec tsc -b
```

Expected: tsc clean, and `s.System.Manager.DateAndTime.dateTimeLocked` now typechecks.

---

### Task 3: backend — `internal/clock` MasterClock package

**Files:**
- Create: `packages/backend/internal/clock/clock.go`
- Test: `packages/backend/internal/clock/clock_test.go`

**Interfaces:**
- Consumes: `goredis "github.com/redis/go-redis/v9"` (already in go.mod), miniredis (test).
- Produces (used by Tasks 4–6):
  - `type State struct { Active bool; VirtualAt time.Time; WallAt time.Time }` with `func (st State) NowAt(wall time.Time) time.Time`
  - `func New(rdb *goredis.Client, logger *slog.Logger) *MasterClock`
  - `func (m *MasterClock) OnChange(fn func(State))` (set once, before Load/Run)
  - `func (m *MasterClock) Now() (time.Time, bool)` — false when inactive
  - `func (m *MasterClock) Snapshot() State`
  - `func (m *MasterClock) Set(ctx context.Context, t time.Time) error`
  - `func (m *MasterClock) Release(ctx context.Context) error`
  - `func (m *MasterClock) Load(ctx context.Context) error`
  - `func (m *MasterClock) Run(ctx context.Context)` (blocking; run in a goroutine)

- [ ] **Step 1: Write the failing tests**

Create `packages/backend/internal/clock/clock_test.go`:

```go
package clock

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"
)

func newTestClock(t *testing.T) (*MasterClock, *goredis.Client, func()) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis.Run: %v", err)
	}
	rdb := goredis.NewClient(&goredis.Options{Addr: mr.Addr()})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return New(rdb, logger), rdb, func() {
		rdb.Close()
		mr.Close()
	}
}

func TestStateNowAt(t *testing.T) {
	anchor := time.Date(2001, 9, 11, 12, 46, 0, 0, time.UTC)
	wall := time.Date(2026, 7, 16, 20, 0, 0, 0, time.UTC)
	st := State{Active: true, VirtualAt: anchor, WallAt: wall}

	got := st.NowAt(wall.Add(90 * time.Second))
	want := anchor.Add(90 * time.Second)
	if !got.Equal(want) {
		t.Fatalf("NowAt: got %v, want %v", got, want)
	}
}

func TestSetNowRelease(t *testing.T) {
	mc, _, done := newTestClock(t)
	defer done()
	ctx := context.Background()

	if _, ok := mc.Now(); ok {
		t.Fatal("new MasterClock must be inactive")
	}

	target := time.Date(2001, 9, 11, 13, 3, 0, 0, time.UTC)
	if err := mc.Set(ctx, target); err != nil {
		t.Fatalf("Set: %v", err)
	}
	now, ok := mc.Now()
	if !ok {
		t.Fatal("expected active after Set")
	}
	if d := now.Sub(target); d < 0 || d > time.Second {
		t.Fatalf("master time %v not within 1s after target %v", now, target)
	}

	if err := mc.Release(ctx); err != nil {
		t.Fatalf("Release: %v", err)
	}
	if _, ok := mc.Now(); ok {
		t.Fatal("expected inactive after Release")
	}
}

func TestLoadRestoresPersistedState(t *testing.T) {
	mc, rdb, done := newTestClock(t)
	defer done()
	ctx := context.Background()

	target := time.Date(2001, 9, 11, 14, 0, 0, 0, time.UTC)
	if err := mc.Set(ctx, target); err != nil {
		t.Fatalf("Set: %v", err)
	}

	// A "restarted pod": fresh MasterClock over the same Redis.
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	mc2 := New(rdb, logger)
	if err := mc2.Load(ctx); err != nil {
		t.Fatalf("Load: %v", err)
	}
	if _, ok := mc2.Now(); !ok {
		t.Fatal("expected loaded clock to be active")
	}
}

func TestOnChangeFiresOnceForLocalApply(t *testing.T) {
	mc, _, done := newTestClock(t)
	defer done()
	ctx := context.Background()

	fired := make(chan State, 4)
	mc.OnChange(func(st State) { fired <- st })

	if err := mc.Set(ctx, time.Date(2001, 9, 11, 13, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("Set: %v", err)
	}
	st := <-fired
	if !st.Active {
		t.Fatal("expected active state in change callback")
	}
	select {
	case extra := <-fired:
		t.Fatalf("unexpected second onChange: %+v", extra)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestRunAppliesPublishedState(t *testing.T) {
	mc, rdb, done := newTestClock(t)
	defer done()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Second process sharing the same Redis, running the subscriber.
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	mc2 := New(rdb, logger)
	applied := make(chan State, 1)
	mc2.OnChange(func(st State) { applied <- st })
	go mc2.Run(ctx)
	time.Sleep(50 * time.Millisecond) // let the subscription attach

	if err := mc.Set(ctx, time.Date(2001, 9, 11, 13, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("Set: %v", err)
	}
	select {
	case st := <-applied:
		if !st.Active {
			t.Fatal("expected active state via pub/sub")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("subscriber never applied the published state")
	}
	if _, ok := mc2.Now(); !ok {
		t.Fatal("mc2 should be active after pub/sub apply")
	}
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/backend && go test ./internal/clock/...`
Expected: FAIL — package does not exist.

- [ ] **Step 3: Write the implementation**

Create `packages/backend/internal/clock/clock.go`:

```go
// Package clock owns forced-clock-mode state: an operator-set master clock
// that every session is slaved to while active. State is persisted in Redis
// (survives pod restarts) and fanned out across pods via pub/sub.
package clock

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	goredis "github.com/redis/go-redis/v9"
)

const (
	redisKey     = "clock:master"
	redisChannel = "clock:master:changed"
)

// State is the persisted master-clock state. Current master time is
// VirtualAt + (wallNow − WallAt): two anchors, no ticker, drift-free.
type State struct {
	Active    bool      `json:"active"`
	VirtualAt time.Time `json:"virtual_at"`
	WallAt    time.Time `json:"wall_at"`
}

// NowAt returns the master virtual time at the given wall-clock instant.
func (st State) NowAt(wall time.Time) time.Time {
	return st.VirtualAt.Add(wall.Sub(st.WallAt))
}

func (st State) equal(other State) bool {
	return st.Active == other.Active &&
		st.VirtualAt.Equal(other.VirtualAt) &&
		st.WallAt.Equal(other.WallAt)
}

// MasterClock holds the in-process snapshot behind a mutex; Redis is the
// cross-process source of truth.
type MasterClock struct {
	rdb    *goredis.Client
	logger *slog.Logger

	mu sync.RWMutex
	st State

	// onChange fires after every applied state change (local Set/Release,
	// boot Load of an active state, or a pub/sub apply). The Hub hooks this
	// to broadcast a clock frame. Set once, before Load/Run.
	onChange func(State)
}

func New(rdb *goredis.Client, logger *slog.Logger) *MasterClock {
	return &MasterClock{rdb: rdb, logger: logger}
}

func (m *MasterClock) OnChange(fn func(State)) { m.onChange = fn }

// Now returns the current master time and whether forced mode is active.
func (m *MasterClock) Now() (time.Time, bool) {
	m.mu.RLock()
	st := m.st
	m.mu.RUnlock()
	if !st.Active {
		return time.Time{}, false
	}
	return st.NowAt(time.Now().UTC()), true
}

func (m *MasterClock) Snapshot() State {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.st
}

// Set enables forced mode at master time t (or jumps an already-active one).
func (m *MasterClock) Set(ctx context.Context, t time.Time) error {
	return m.apply(ctx, State{Active: true, VirtualAt: t.UTC(), WallAt: time.Now().UTC()})
}

// Release disables forced mode. Clients keep ticking from wherever the
// master left them; nothing jumps back.
func (m *MasterClock) Release(ctx context.Context) error {
	return m.apply(ctx, State{Active: false})
}

func (m *MasterClock) apply(ctx context.Context, st State) error {
	data, err := json.Marshal(st)
	if err != nil {
		return err
	}
	if err := m.rdb.Set(ctx, redisKey, data, 0).Err(); err != nil {
		return err
	}
	// Round-trip through JSON so the local copy matches what subscribers
	// decode (strips the monotonic wall-clock reading; keeps the setLocal
	// dedupe honest when our own publish echoes back).
	var canonical State
	if err := json.Unmarshal(data, &canonical); err != nil {
		return err
	}
	m.setLocal(canonical)
	// Publish failure is non-fatal: this pod has already applied and
	// broadcast; other pods recover on their next boot Load.
	if err := m.rdb.Publish(ctx, redisChannel, data).Err(); err != nil {
		m.logger.Warn("master clock publish failed", "error", err)
	}
	return nil
}

func (m *MasterClock) setLocal(st State) {
	m.mu.Lock()
	same := m.st.equal(st)
	m.st = st
	m.mu.Unlock()
	if same || m.onChange == nil {
		return
	}
	m.onChange(st)
}

// Load reads persisted state at boot so a restart mid-session stays forced.
func (m *MasterClock) Load(ctx context.Context) error {
	data, err := m.rdb.Get(ctx, redisKey).Bytes()
	if err == goredis.Nil {
		return nil
	}
	if err != nil {
		return err
	}
	var st State
	if err := json.Unmarshal(data, &st); err != nil {
		return err
	}
	m.setLocal(st)
	return nil
}

// Run applies published state changes for the process lifetime. go-redis
// PubSub reconnects internally; the loop exits when ctx is canceled.
func (m *MasterClock) Run(ctx context.Context) {
	sub := m.rdb.Subscribe(ctx, redisChannel)
	defer sub.Close()
	for msg := range sub.Channel() {
		var st State
		if err := json.Unmarshal([]byte(msg.Payload), &st); err != nil {
			m.logger.Warn("bad master clock notification", "payload", msg.Payload, "error", err)
			continue
		}
		m.setLocal(st)
	}
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd packages/backend && go test ./internal/clock/... -v 2>&1 | tail -15`
Expected: PASS, 5 tests. (`TestOnChangeFiresOnceForLocalApply` is the dedupe check: our own publish echoing back through a subscriber must not double-fire.)

- [ ] **Step 5: Commit**

```bash
git add packages/backend/internal/clock/
git commit -m "feat(streamer): Redis-backed MasterClock for forced clock mode"
```

---

### Task 4: backend — Hub/Session integration (clock frames, heartbeat enrichment)

**Files:**
- Modify: `packages/backend/internal/session/hub.go` (master field + accessors + broadcast)
- Modify: `packages/backend/internal/session/session.go` (`outMsg` fields, `SendClock`, `Heartbeat`, `Pause`)
- Test: `packages/backend/internal/session/session_test.go` (extend)

**Interfaces:**
- Consumes: `clock.MasterClock`, `clock.State` (Task 3); existing `outMsg`, `send_`, `newTestSession`, `recvType`.
- Produces (used by Tasks 5–6):
  - `func (h *Hub) SetMaster(m *clock.MasterClock)` — call once at boot, before serving
  - `func (h *Hub) MasterNow() (time.Time, bool)` — nil-safe
  - `func (h *Hub) BroadcastClock(st clock.State)`
  - `func (s *Session) SendClock(active bool, t time.Time)`
  - `outMsg` gains `Active *bool "json:\"active,omitempty\""` and `MasterTime string "json:\"master_time,omitempty\""`
  - While forced: `Heartbeat` pins `virtualTime` to master and acks with `master_time`; `Pause` is a no-op (acked, not applied).

- [ ] **Step 1: Write the failing tests**

Append to `packages/backend/internal/session/session_test.go` (imports to add: `"context"`, `"github.com/alicebob/miniredis/v2"`, `goredis "github.com/redis/go-redis/v9"`, `"classicy/streamer/internal/clock"`):

```go
// forcedTestSession returns a session whose hub has an ACTIVE master clock
// pinned at target, plus the MasterClock for further manipulation.
func forcedTestSession(t *testing.T, target time.Time) (*Session, *clock.MasterClock) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis.Run: %v", err)
	}
	t.Cleanup(mr.Close)
	rdb := goredis.NewClient(&goredis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	mc := clock.New(rdb, logger)
	if err := mc.Set(context.Background(), target); err != nil {
		t.Fatalf("mc.Set: %v", err)
	}
	hub := NewHub(logger, 0)
	hub.SetMaster(mc)
	return NewSession(hub, nil, nil, logger), mc
}

func TestHeartbeatUnforcedHasNoMasterTime(t *testing.T) {
	s := newTestSession(t)
	s.Heartbeat(time.Date(2001, 9, 11, 13, 0, 0, 0, time.UTC))
	ack := recvType(t, s)
	if ack.Type != "heartbeat_ack" || ack.MasterTime != "" {
		t.Fatalf("expected plain heartbeat_ack, got %+v", ack)
	}
}

func TestHeartbeatForcedPinsToMasterAndAcksMasterTime(t *testing.T) {
	master := time.Date(2001, 9, 11, 13, 3, 0, 0, time.UTC)
	s, _ := forcedTestSession(t, master)

	// Client reports a wildly different time; the server must ignore it.
	s.Heartbeat(time.Date(2001, 9, 11, 8, 0, 0, 0, time.UTC))
	ack := recvType(t, s)
	if ack.Type != "heartbeat_ack" {
		t.Fatalf("expected heartbeat_ack, got %+v", ack)
	}
	if ack.MasterTime == "" {
		t.Fatal("expected master_time while forced")
	}
	ackTime, err := time.Parse(time.RFC3339, ack.MasterTime)
	if err != nil {
		t.Fatalf("bad master_time: %v", err)
	}
	if d := ackTime.Sub(master); d < 0 || d > 2*time.Second {
		t.Fatalf("master_time %v not near master %v", ackTime, master)
	}
	if vt := s.VirtualTime(); vt.Sub(master) < 0 || vt.Sub(master) > 2*time.Second {
		t.Fatalf("virtualTime %v not pinned to master %v", vt, master)
	}
}

func TestSendClock(t *testing.T) {
	s := newTestSession(t)
	target := time.Date(2001, 9, 11, 13, 3, 0, 0, time.UTC)

	s.SendClock(true, target)
	m := recvType(t, s)
	if m.Type != "clock" || m.Active == nil || !*m.Active || m.Time != target.Format(time.RFC3339) {
		t.Fatalf("bad active clock frame: %+v", m)
	}

	s.SendClock(false, time.Time{})
	m = recvType(t, s)
	if m.Type != "clock" || m.Active == nil || *m.Active || m.Time != "" {
		t.Fatalf("bad release clock frame: %+v", m)
	}
}

func TestPauseIgnoredWhileForced(t *testing.T) {
	s, _ := forcedTestSession(t, time.Date(2001, 9, 11, 13, 0, 0, 0, time.UTC))
	s.Pause()
	if ack := recvType(t, s); ack.Type != "pause_ack" {
		t.Fatalf("expected pause_ack, got %+v", ack)
	}
	s.mu.Lock()
	paused := s.paused
	s.mu.Unlock()
	if paused {
		t.Fatal("pause must not apply while the clock is forced")
	}
}

func TestBroadcastClockReachesRegisteredSessions(t *testing.T) {
	master := time.Date(2001, 9, 11, 13, 3, 0, 0, time.UTC)
	s, mc := forcedTestSession(t, master)
	hub := s.hub
	// Register synchronously (bypass the async reg channel — Run isn't running).
	hub.mu.Lock()
	hub.sessions[s.id] = s
	hub.mu.Unlock()

	hub.BroadcastClock(mc.Snapshot())
	m := recvType(t, s)
	if m.Type != "clock" || m.Active == nil || !*m.Active {
		t.Fatalf("expected active clock broadcast, got %+v", m)
	}

	hub.BroadcastClock(clock.State{Active: false})
	m = recvType(t, s)
	if m.Type != "clock" || m.Active == nil || *m.Active {
		t.Fatalf("expected release clock broadcast, got %+v", m)
	}
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/backend && go test ./internal/session/... 2>&1 | tail -10`
Expected: compile FAIL (`SetMaster`, `SendClock`, `MasterTime`, `Active` undefined).

- [ ] **Step 3: Implement Hub changes**

In `packages/backend/internal/session/hub.go`, add the import `"classicy/streamer/internal/clock"`, add a field to `Hub` (after `logger *slog.Logger`):

```go
	// master is the optional process-wide forced clock (nil when the feature
	// is disabled). Set once at boot via SetMaster; reads are nil-safe.
	master *clock.MasterClock
```

and add methods:

```go
// SetMaster wires the forced master clock. Call once at boot, before Run.
func (h *Hub) SetMaster(m *clock.MasterClock) { h.master = m }

// MasterNow returns the forced master time, or false when the feature is
// disabled or inactive.
func (h *Hub) MasterNow() (time.Time, bool) {
	if h.master == nil {
		return time.Time{}, false
	}
	return h.master.Now()
}

// BroadcastClock pushes the forced-clock state to every connected session.
// RLock + non-blocking send_ per session — same discipline as the tick loop.
func (h *Hub) BroadcastClock(st clock.State) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, s := range h.sessions {
		if st.Active {
			s.SendClock(true, st.NowAt(time.Now().UTC()))
		} else {
			s.SendClock(false, time.Time{})
		}
	}
}
```

- [ ] **Step 4: Implement Session changes**

In `packages/backend/internal/session/session.go`:

(a) Add two fields to the `outMsg` struct (session.go:79-99), alongside the existing optional fields:

```go
	// Forced-clock mode (see internal/clock): "clock" frames carry Active
	// (+Time while active); heartbeat_ack carries MasterTime while forced.
	Active     *bool  `json:"active,omitempty"`
	MasterTime string `json:"master_time,omitempty"`
```

(b) Add `SendClock` next to the other ack senders:

```go
// SendClock pushes the forced-clock state to this client. While active the
// client slaves its virtual clock to Time; on release it keeps ticking from
// wherever the master left it.
func (s *Session) SendClock(active bool, t time.Time) {
	m := outMsg{Type: "clock", Active: &active}
	if active {
		m.Time = t.Format(time.RFC3339)
	}
	s.send_(m)
}
```

(c) Replace `Heartbeat` (session.go:477-487) with:

```go
func (s *Session) Heartbeat(clientTime time.Time) {
	masterTime, forced := s.hub.MasterNow()

	s.mu.Lock()
	if forced {
		// Forced mode inverts drift correction: the server wins. Pin the
		// session clock to master so windowed queries track the broadcast.
		s.virtualTime = masterTime
	} else if drift := abs(clientTime.Sub(s.virtualTime)); drift > driftThresh {
		s.logger.Info("correcting drift", "drift", drift)
		s.virtualTime = clientTime
	}
	t := s.virtualTime
	s.mu.Unlock()

	m := outMsg{Type: "heartbeat_ack", Time: t.Format(time.RFC3339)}
	if forced {
		m.MasterTime = masterTime.Format(time.RFC3339)
	}
	s.send_(m)
}
```

(d) Replace `Pause` (session.go:461-466) with:

```go
func (s *Session) Pause() {
	// The master clock never pauses; while forced, a client pause would only
	// desync it until the next heartbeat clamp. Ack (client protocol expects
	// it) but don't apply.
	if _, forced := s.hub.MasterNow(); forced {
		s.send_(outMsg{Type: "pause_ack"})
		return
	}
	s.mu.Lock()
	s.paused = true
	s.mu.Unlock()
	s.send_(outMsg{Type: "pause_ack"})
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `cd packages/backend && go test ./internal/session/... 2>&1 | tail -5`
Expected: PASS (new tests + entire existing suite — `Heartbeat`'s unforced path is behavior-identical).

- [ ] **Step 6: Commit**

```bash
git add packages/backend/internal/session/
git commit -m "feat(streamer): clock frames, forced heartbeat pinning, hub master wiring"
```

---

### Task 5: backend — handler clamping + clock push on connect

**Files:**
- Modify: `packages/backend/internal/handler/ws.go`

**Interfaces:**
- Consumes: `hub.MasterNow()` (Task 4), `sess.SendClock` (Task 4).
- Produces: while forced — `init`/`seek` times are clamped **before** the `db.CurrentItems` query (so the ack's items match master time); every new connection receives a `clock` frame immediately after the session is registered.

No isolated unit test: this is thin wiring over `MasterNow` (covered in Task 4's tests) around the existing DB query path, which has no handler-level test harness. It is exercised end-to-end in Task 10's verification. Do not silently skip that verification.

- [ ] **Step 1: Add the clamp helper and connect push**

In `NewWSHandler`'s connection setup (after the session is constructed and registered with the hub, before the read loop), add:

```go
	// Late joiners are locked immediately; everyone else heard the broadcast.
	if t, ok := hub.MasterNow(); ok {
		sess.SendClock(true, t)
	}
```

Inside the handler closure, next to `parseTime` usage, add:

```go
	// effectiveTime substitutes the master time for any client-supplied time
	// while forced mode is active — a divergent or hand-rolled client cannot
	// stream data from a different moment.
	effectiveTime := func(t time.Time) time.Time {
		if mt, ok := hub.MasterNow(); ok {
			return mt
		}
		return t
	}
```

- [ ] **Step 2: Clamp init and seek**

In the `case "init":` body, immediately after the successful `parseTime(msg.Time)` and before `db.CurrentItems` is called, insert:

```go
			t = effectiveTime(t)
```

Do exactly the same in `case "seek":`. (`case "heartbeat":` needs no change — `Session.Heartbeat` pins internally per Task 4.)

- [ ] **Step 3: Build + full backend suite**

Run: `cd packages/backend && go vet ./... && go test ./... 2>&1 | tail -3`
Expected: clean vet, all green.

- [ ] **Step 4: Commit**

```bash
git add packages/backend/internal/handler/ws.go
git commit -m "feat(streamer): clamp init/seek to master time; push clock frame on connect"
```

---

### Task 6: backend — REST `/clock` endpoint + main wiring

**Files:**
- Create: `packages/backend/internal/handler/clock.go`
- Test: `packages/backend/internal/handler/clock_test.go`
- Modify: `packages/backend/cmd/server/main.go`

**Interfaces:**
- Consumes: `clock.MasterClock` (Task 3), `hub.SetMaster`/`BroadcastClock` (Task 4), `parseTime` (same package), `env` helper (main.go).
- Produces: `func NewClockHandler(mc *clock.MasterClock, key string, logger *slog.Logger) http.HandlerFunc` at route `/clock`; env var `CLOCK_CONTROL_KEY`.

- [ ] **Step 1: Write the failing tests**

Create `packages/backend/internal/handler/clock_test.go`:

```go
package handler

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"

	"classicy/streamer/internal/clock"
)

func newClockTestHandler(t *testing.T, key string) (http.HandlerFunc, *clock.MasterClock) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis.Run: %v", err)
	}
	t.Cleanup(mr.Close)
	rdb := goredis.NewClient(&goredis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	mc := clock.New(rdb, logger)
	return NewClockHandler(mc, key, logger), mc
}

func doClock(h http.HandlerFunc, method, key, body string) *httptest.ResponseRecorder {
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, "/clock", rdr)
	if key != "" {
		req.Header.Set("X-Clock-Key", key)
	}
	w := httptest.NewRecorder()
	h(w, req)
	return w
}

func TestClockDisabledWithoutKeyConfig(t *testing.T) {
	h, _ := newClockTestHandler(t, "")
	if w := doClock(h, http.MethodGet, "anything", ""); w.Code != http.StatusNotFound {
		t.Fatalf("expected 404 when feature is off, got %d", w.Code)
	}
}

func TestClockRejectsWrongKey(t *testing.T) {
	h, _ := newClockTestHandler(t, "sekrit")
	if w := doClock(h, http.MethodGet, "wrong", ""); w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", w.Code)
	}
	if w := doClock(h, http.MethodGet, "", ""); w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 with no key header, got %d", w.Code)
	}
}

func TestClockActivateStatusRelease(t *testing.T) {
	h, mc := newClockTestHandler(t, "sekrit")

	w := doClock(h, http.MethodPost, "sekrit", `{"active":true,"time":"2001-09-11T13:03:00Z"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("activate: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"active":true`) {
		t.Fatalf("activate response missing active:true: %s", w.Body.String())
	}
	if now, ok := mc.Now(); !ok || now.Before(time.Date(2001, 9, 11, 13, 3, 0, 0, time.UTC)) {
		t.Fatalf("master clock not set: %v %v", now, ok)
	}

	if w := doClock(h, http.MethodGet, "sekrit", ""); !strings.Contains(w.Body.String(), `"active":true`) {
		t.Fatalf("status should be active: %s", w.Body.String())
	}

	w = doClock(h, http.MethodPost, "sekrit", `{"active":false}`)
	if w.Code != http.StatusOK {
		t.Fatalf("release: expected 200, got %d", w.Code)
	}
	if _, ok := mc.Now(); ok {
		t.Fatal("master clock should be inactive after release")
	}
}

func TestClockBadRequests(t *testing.T) {
	h, _ := newClockTestHandler(t, "sekrit")
	if w := doClock(h, http.MethodPost, "sekrit", `{"active":true,"time":"yesterday"}`); w.Code != http.StatusBadRequest {
		t.Fatalf("bad time: expected 400, got %d", w.Code)
	}
	if w := doClock(h, http.MethodPost, "sekrit", `not json`); w.Code != http.StatusBadRequest {
		t.Fatalf("bad json: expected 400, got %d", w.Code)
	}
	if w := doClock(h, http.MethodPut, "sekrit", ""); w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("PUT: expected 405, got %d", w.Code)
	}
	if w := doClock(h, http.MethodPost, "sekrit", `{"active":true}`); w.Code != http.StatusBadRequest {
		t.Fatalf("activate without time: expected 400, got %d", w.Code)
	}
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/backend && go test ./internal/handler/ -run TestClock 2>&1 | tail -5`
Expected: compile FAIL — `NewClockHandler` undefined.

- [ ] **Step 3: Write the handler**

Create `packages/backend/internal/handler/clock.go`:

```go
package handler

import (
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"classicy/streamer/internal/clock"
)

type clockRequest struct {
	Active bool   `json:"active"`
	Time   string `json:"time,omitempty"`
}

type clockResponse struct {
	Active bool   `json:"active"`
	Time   string `json:"time,omitempty"`
}

// NewClockHandler serves the operator control API for forced clock mode:
//
//	GET  /clock                                  → current state
//	POST /clock {"active":true,"time":"..."}     → enable / jump
//	POST /clock {"active":false}                 → release
//
// Both verbs require the X-Clock-Key header to match key (constant-time).
// An empty key disables the feature entirely: every request 404s.
func NewClockHandler(mc *clock.MasterClock, key string, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if key == "" {
			http.NotFound(w, r)
			return
		}
		provided := []byte(r.Header.Get("X-Clock-Key"))
		if subtle.ConstantTimeCompare(provided, []byte(key)) != 1 {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}

		switch r.Method {
		case http.MethodGet:
			writeClockState(w, mc)

		case http.MethodPost:
			var req clockRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
				return
			}
			if req.Active {
				t, err := parseTime(req.Time)
				if err != nil {
					http.Error(w, err.Error(), http.StatusBadRequest)
					return
				}
				if err := mc.Set(r.Context(), t); err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
				logger.Info("forced clock set", "time", t)
			} else {
				if err := mc.Release(r.Context()); err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
				logger.Info("forced clock released")
			}
			writeClockState(w, mc)

		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	}
}

func writeClockState(w http.ResponseWriter, mc *clock.MasterClock) {
	resp := clockResponse{}
	if t, ok := mc.Now(); ok {
		resp.Active = true
		resp.Time = t.UTC().Format(time.RFC3339)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
```

(Note: `parseTime("")` fails with "cannot parse", so activate-without-time is a 400 with no extra code.)

- [ ] **Step 4: Wire main.go**

In `cmd/server/main.go`, after `hub := session.NewHub(...)` / `go hub.Run()` and before the mux routes, add (import `"classicy/streamer/internal/clock"`):

```go
	// Forced clock mode: operator-set master clock, persisted in Redis so a
	// restart mid-session stays forced. OnChange broadcasts to every session;
	// late joiners get their frame from the connect path in the WS handler.
	masterClock := clock.New(rdb, logger)
	masterClock.OnChange(func(st clock.State) { hub.BroadcastClock(st) })
	if err := masterClock.Load(ctx); err != nil {
		logger.Warn("master clock load failed; starting unforced", "error", err)
	}
	hub.SetMaster(masterClock)
	go masterClock.Run(ctx)
```

and register the route next to `/feedback`:

```go
	mux.HandleFunc("/clock", handler.NewClockHandler(masterClock, env("CLOCK_CONTROL_KEY", ""), logger))
```

- [ ] **Step 5: Run the full backend suite**

Run: `cd packages/backend && go vet ./... && go test ./... 2>&1 | tail -3`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/backend/internal/handler/clock.go packages/backend/internal/handler/clock_test.go packages/backend/cmd/server/main.go
git commit -m "feat(streamer): key-guarded REST /clock control API"
```

---

### Task 7: frontend — `clock` / `heartbeat_ack` handling in MediaStreamProvider

**Files:**
- Modify: `packages/frontend/src/Providers/MediaStream/MediaStreamContext.ts` (types + context field)
- Modify: `packages/frontend/src/Providers/MediaStream/MediaStreamProvider.tsx`
- Test: `packages/frontend/src/Providers/MediaStream/MediaStreamProvider.clock.test.tsx` (new)

**Interfaces:**
- Consumes: wire frames from Tasks 4–5; `setDateTimeFromUtc` from `../../Applications/TimeMachine/setVirtualClock`; `setDateTime` from `useClassicyDateTime` (already returned by the hook; the provider just hasn't destructured it before).
- Produces (used by Tasks 8–9): `MediaStreamContextValue.clockForced: boolean`; exported `FORCED_DRIFT_THRESHOLD_MS = 2_000`; wire types `WsClockMessage`, `WsHeartbeatAckMessage`.

- [ ] **Step 1: Write the failing tests**

Create `MediaStreamProvider.clock.test.tsx`. Copy the harness (FakeWebSocket, `frame()`, ContextCapture, `vi.stubGlobal`) from `MediaStreamProvider.weather.test.tsx` verbatim, with ONE change — the classicy mock gains `setDateTime`:

```tsx
const setDateTimeMock = vi.hoisted(() => vi.fn());
vi.mock("classicy", () => ({
	useClassicyDateTime: () => ({
		localDate: FIXED_LOCAL_DATE,
		dateTime: mockDateTime,
		tzOffset: 0,
		setDateTime: setDateTimeMock,
	}),
	useAppManager: (selector: (s: unknown) => unknown) =>
		selector({
			System: {
				Manager: {
					DateAndTime: { dateTimeLocked: false },
					Applications: { apps: {} },
				},
			},
		}),
	useAppManagerDispatch: () => vi.fn(),
}));
```

Then the cases (NOW_ISO is `"2001-09-11T13:00:00.000Z"` as in the weather test):

```tsx
describe("forced clock", () => {
	it("clock frame with active:true jumps the clock and sets clockForced", () => {
		renderProvider();
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());

		act(() => ws.onmessage?.(frame({ type: "clock", active: true, time: "2001-09-11T14:00:00Z" })));

		expect(setDateTimeMock).toHaveBeenCalledTimes(1);
		expect((setDateTimeMock.mock.calls[0][0] as Date).toISOString()).toBe("2001-09-11T14:00:00.000Z");
		expect(captured.current?.clockForced).toBe(true);
	});

	it("clock frame within the drift threshold does not touch the clock", () => {
		renderProvider();
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());

		// 1 s ahead of NOW_ISO — under FORCED_DRIFT_THRESHOLD_MS.
		act(() => ws.onmessage?.(frame({ type: "clock", active: true, time: "2001-09-11T13:00:01Z" })));

		expect(setDateTimeMock).not.toHaveBeenCalled();
		expect(captured.current?.clockForced).toBe(true);
	});

	it("heartbeat_ack.master_time corrects drift beyond the threshold", () => {
		renderProvider();
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());

		act(() => ws.onmessage?.(frame({ type: "heartbeat_ack", time: "x", master_time: "2001-09-11T13:00:05Z" })));

		expect(setDateTimeMock).toHaveBeenCalledTimes(1);
		expect(captured.current?.clockForced).toBe(true);
	});

	it("heartbeat_ack without master_time clears clockForced (release self-heal)", () => {
		renderProvider();
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());

		act(() => ws.onmessage?.(frame({ type: "clock", active: true, time: "2001-09-11T14:00:00Z" })));
		expect(captured.current?.clockForced).toBe(true);

		act(() => ws.onmessage?.(frame({ type: "heartbeat_ack", time: "2001-09-11T14:00:30Z" })));
		expect(captured.current?.clockForced).toBe(false);
	});

	it("clock frame with active:false clears clockForced without moving the clock", () => {
		renderProvider();
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());

		act(() => ws.onmessage?.(frame({ type: "clock", active: true, time: "2001-09-11T14:00:00Z" })));
		setDateTimeMock.mockClear();

		act(() => ws.onmessage?.(frame({ type: "clock", active: false })));
		expect(captured.current?.clockForced).toBe(false);
		expect(setDateTimeMock).not.toHaveBeenCalled();
	});
});
```

(`renderProvider`/`captured` are the same ContextCapture helpers as the weather test; include `afterEach(cleanup)` and the `vi.unstubAllGlobals()` teardown, and clear `setDateTimeMock` in `beforeEach`.)

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Providers/MediaStream/MediaStreamProvider.clock.test.tsx 2>&1 | tail -5`
Expected: FAIL — `clockForced` undefined on the context, no clock handling.

- [ ] **Step 3: Add the wire types + context field**

In `MediaStreamContext.ts`, next to the other `Ws*` message interfaces:

```ts
/** Forced clock mode: the server owns the clock while active. */
export interface WsClockMessage {
	type: "clock";
	active: boolean;
	time?: string;
}

export interface WsHeartbeatAckMessage {
	type: "heartbeat_ack";
	time: string;
	/** Present only while forced mode is active. */
	master_time?: string;
}
```

Add both to the `WsIncomingMessage` union. Add to `MediaStreamContextValue`:

```ts
	/** True while the server is forcing the clock (Time Machine locked). */
	clockForced: boolean;
```

and `clockForced: false` to the `createContext` default object.

- [ ] **Step 4: Handle the frames in the provider**

In `MediaStreamProvider.tsx`:

(a) Destructure the setter: change the clock read (L164) to
`const { localDate, dateTime, tzOffset, setDateTime } = useClassicyDateTime({ tick: true });`
and keep it fresh for the socket closure:

```tsx
	const setDateTimeRef = useRef(setDateTime);
	useEffect(() => {
		setDateTimeRef.current = setDateTime;
	}, [setDateTime]);
```

(b) Imports + constants (next to `SEEK_THRESHOLD_MS`):

```tsx
import { setDateTimeFromUtc } from "../../Applications/TimeMachine/setVirtualClock";
```

```tsx
// Forced clock mode: corrections smaller than this are ignored (the local
// clock is close enough); larger ones snap to master via the sanctioned
// setDateTimeFromUtc seam. Kept well under SEEK_THRESHOLD_MS so routine
// corrections never clear buffers — only real operator jumps do.
export const FORCED_DRIFT_THRESHOLD_MS = 2_000;
```

(c) State + apply helper (near the other provider state):

```tsx
	const [clockForced, setClockForced] = useState(false);
	const clockForcedRef = useRef(false);

	const applyForcedTime = useCallback((iso: string) => {
		const masterMs = new Date(iso).getTime();
		if (Number.isNaN(masterMs)) return;
		if (Math.abs(masterMs - utcMsRef.current) > FORCED_DRIFT_THRESHOLD_MS) {
			setDateTimeFromUtc(setDateTimeRef.current, iso);
		}
	}, []);

	const setForced = useCallback((forced: boolean) => {
		if (clockForcedRef.current === forced) return;
		clockForcedRef.current = forced;
		setClockForced(forced);
	}, []);
```

(d) In `ws.onmessage`, add two branches **before** the final `items`/`init_ack`/`seek_ack` guard:

```tsx
			if (msg.type === "clock") {
				const m = msg as WsClockMessage;
				setForced(m.active);
				if (m.active && m.time) applyForcedTime(m.time);
				return;
			}

			if (msg.type === "heartbeat_ack") {
				const m = msg as WsHeartbeatAckMessage;
				// master_time presence IS the forced signal — self-heals a
				// missed clock frame in either direction.
				setForced(typeof m.master_time === "string");
				if (m.master_time) applyForcedTime(m.master_time);
				return;
			}
```

(e) Add `clockForced` to the `contextValue` object and its `useMemo` deps.

A forced jump > 90 s lands in classicy state, which trips the provider's existing seek-detection effect: buffers clear and a `seek` goes out, which the server clamps to master — resync is entirely reused machinery.

- [ ] **Step 5: Run to verify they pass, plus the neighboring suites**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Providers/MediaStream/ 2>&1 | tail -5`
Expected: all MediaStream suites green (the weather/flights/playlistGating classicy mocks don't return `setDateTime`, but nothing calls it in those tests — destructuring `undefined` is safe).

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/Providers/MediaStream/
git commit -m "feat(frontend): obey server-forced clock (clock frame + heartbeat drift correction)"
```

---

### Task 8: frontend — desktop enforcement (Time Machine, Date & Time lock, playlist jumps)

**Files:**
- Modify: `packages/frontend/src/Providers/MediaStream/MediaStreamProvider.tsx` (enforcement effects)
- Modify: `packages/frontend/src/Providers/Playlist/PlaylistProvider.tsx` (jump suppression)
- Test: extend `MediaStreamProvider.clock.test.tsx`; extend `packages/frontend/src/Providers/Playlist/PlaylistProvider.test.tsx`

**Interfaces:**
- Consumes: `clockForced` (Task 7); classicy `useAppManager`, `useAppManagerDispatch`, actions `ClassicyManagerDateTimeLock`/`Unlock` (Task 1), `ClassicyAppClose`, `ClassicyDesktopShowErrorDialog` (PlaylistProvider precedent at L150-166); `dateTimeLocked` state (Task 1).
- Produces: while forced — Date & Time editors locked, Time Machine force-closed and re-closed on any open, playlist `jump` entries skipped. `dateTimeLocked` in the classicy store is the cross-provider signal (PlaylistProvider sits ABOVE MediaStreamProvider and cannot read its context).

- [ ] **Step 1: Write the failing tests**

Append to `MediaStreamProvider.clock.test.tsx` — upgrade the classicy mock so `useAppManager` reads mutable state and `useAppManagerDispatch` records:

```tsx
const dispatchMock = vi.hoisted(() => vi.fn());
const mockApps = vi.hoisted(() => ({ current: {} as Record<string, { open?: boolean; name?: string; icon?: string }> }));
```

(in the mock: `useAppManagerDispatch: () => dispatchMock`, and the `useAppManager` selector reads `Applications: { apps: mockApps.current }`.)

```tsx
describe("forced clock enforcement", () => {
	it("locks and unlocks the Date & Time editors with forced mode", () => {
		renderProvider();
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());

		act(() => ws.onmessage?.(frame({ type: "clock", active: true, time: "2001-09-11T14:00:00Z" })));
		expect(dispatchMock).toHaveBeenCalledWith({ type: "ClassicyManagerDateTimeLock" });

		act(() => ws.onmessage?.(frame({ type: "clock", active: false })));
		expect(dispatchMock).toHaveBeenCalledWith({ type: "ClassicyManagerDateTimeUnlock" });
	});

	it("force-closes Time Machine while forced", () => {
		mockApps.current = { "TimeMachine.app": { open: true, name: "Time Machine", icon: "tm.png" } };
		renderProvider();
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());

		act(() => ws.onmessage?.(frame({ type: "clock", active: true, time: "2001-09-11T14:00:00Z" })));

		expect(dispatchMock).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "ClassicyAppClose",
				app: expect.objectContaining({ id: "TimeMachine.app" }),
			}),
		);
	});

	it("does not touch Time Machine when not forced", () => {
		mockApps.current = { "TimeMachine.app": { open: true, name: "Time Machine", icon: "tm.png" } };
		renderProvider();
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());

		const closes = dispatchMock.mock.calls.filter((c) => c[0]?.type === "ClassicyAppClose");
		expect(closes).toHaveLength(0);
	});
});
```

For PlaylistProvider, add one case to its existing test file following that file's established harness (it already mocks classicy and drives crossings; reuse its helpers): a playlist with a `jump` entry crossing while `dateTimeLocked: true` in the mocked store must NOT call `setDateTime`; with `dateTimeLocked: false` it must (existing behavior, likely already covered — if so, only add the locked case).

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Providers/MediaStream/MediaStreamProvider.clock.test.tsx 2>&1 | tail -5`
Expected: FAIL — no Lock dispatch, no AppClose.

- [ ] **Step 3: Add the enforcement effects to MediaStreamProvider**

Add classicy imports (`useAppManager`, `useAppManagerDispatch` — extend the existing `classicy` import line), then:

```tsx
	// --- Forced-clock UI enforcement ----------------------------------------
	// Reactive watcher, not action interception — same rationale as
	// PlaylistProvider's disabledApps sweep: watching `open` covers every
	// entry point including desktop-icon opens that never emit ClassicyAppOpen.
	const enforcementDispatch = useAppManagerDispatch();
	const timeMachineApp = useAppManager(
		(s) => s.System.Manager.Applications.apps["TimeMachine.app"],
	);

	useEffect(() => {
		enforcementDispatch({
			type: clockForced ? "ClassicyManagerDateTimeLock" : "ClassicyManagerDateTimeUnlock",
		});
	}, [clockForced, enforcementDispatch]);

	useEffect(() => {
		if (!clockForced || !timeMachineApp?.open) return;
		enforcementDispatch({
			type: "ClassicyAppClose",
			app: {
				id: "TimeMachine.app",
				title: timeMachineApp.name ?? "Time Machine",
				icon: timeMachineApp.icon ?? "",
			},
		});
		enforcementDispatch({
			type: "ClassicyDesktopShowErrorDialog",
			title: "Time Machine",
			message: "The clock is currently controlled by the broadcast operator.",
		});
	}, [clockForced, timeMachineApp, enforcementDispatch]);
```

Before finishing, compare the `app:` payload shape against the real `ClassicyAppClose` dispatch in `PlaylistProvider.tsx:179` and match it exactly (it uses a `playlistAppMeta(appId)` helper — reuse that helper if it's exported; otherwise mirror its returned fields).

- [ ] **Step 4: Suppress playlist jumps while locked**

In `PlaylistProvider.tsx`, add a store read next to its other hooks:

```tsx
	const dateTimeLocked = useAppManager(
		(s) => s.System.Manager.DateAndTime.dateTimeLocked ?? false,
	);
```

and in the crossings loop (L118-143), change the jump branch:

```tsx
			if (e.kind === "jump") {
				// Central forced clock outranks playlist scheduling; the server
				// would clamp the seek anyway — don't fight it client-side.
				if (dateTimeLocked) continue;
				setDateTimeFromUtc(setDateTime, e.to);
				break;
			}
```

Add `dateTimeLocked` to that effect's dependency array.

- [ ] **Step 5: Run to verify everything passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Providers/ 2>&1 | tail -5`
Expected: all provider suites green.

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/Providers/
git commit -m "feat(frontend): forced-clock enforcement — lock D&T editors, close Time Machine, suppress playlist jumps"
```

---

### Task 9: frontend — mobile (iPod) enforcement

**Files:**
- Modify: `packages/frontend/src/Mobile/screens/MainMenu.tsx`
- Modify: `packages/frontend/src/Mobile/IpodShell.tsx`
- Test: extend the existing MainMenu/IpodShell test files if present (check `src/Mobile/**/*.test.tsx`); otherwise create `packages/frontend/src/Mobile/screens/MainMenu.test.tsx` following the frontend's standard RTL + classicy-mock conventions (`afterEach(cleanup)`).

**Interfaces:**
- Consumes: `dateTimeLocked` from the classicy store (`useAppManager`).
- Produces: while locked — the "Time Travel" menu entry is disabled; being on `timeTravel`/`bookmarks`/`scrub` evicts back to the menu; the wheel's play/pause is a no-op.

- [ ] **Step 1: Write the failing test**

In the MainMenu test (create or extend; mock classicy the same way the file's neighbors do, exposing a mutable `dateTimeLocked`):

```tsx
it("disables the Time Travel entry while the clock is forced", () => {
	mockDateTimeLocked.current = true;
	render(<MainMenu {...requiredProps} />);
	const item = screen.getByText("Time Travel").closest("li") ?? screen.getByText("Time Travel");
	expect(item?.getAttribute("aria-disabled") ?? item?.className).toBeTruthy();
});
```

(Assert disabled the way the existing `nowPlaying: disabled: !hasNowPlaying` entry renders it — read the `IpodListItem` rendering to pick the exact attribute/class, and mirror whatever the existing disabled-entry test asserts if one exists.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Mobile/ 2>&1 | tail -5`
Expected: the new test FAILS (entry not disabled).

- [ ] **Step 3: Implement**

`MainMenu.tsx` — read the flag and mark the entry (the entries array at L16-28 already supports `disabled`, used by `nowPlaying`):

```tsx
	const dateTimeLocked = useAppManager(
		(s) => s.System.Manager.DateAndTime.dateTimeLocked ?? false,
	);
```

```tsx
	{ key: "timeTravel", label: "Time Travel", arrow: true, target: "timeTravel", disabled: dateTimeLocked },
```

`IpodShell.tsx` — evict from time-mutating screens and neuter the wheel while locked (the shell owns `screen` state and the `onPlayPause` wheel binding at ~L133; use the same navigation setter its own menu button uses):

```tsx
	const dateTimeLocked = useAppManager(
		(s) => s.System.Manager.DateAndTime.dateTimeLocked ?? false,
	);

	// Forced clock: kick the user off any screen that can move the clock.
	useEffect(() => {
		if (!dateTimeLocked) return;
		if (screen === "timeTravel" || screen === "bookmarks" || screen === "scrub") {
			/* navigate to "menu" via the shell's existing setter — the same one
			   the Menu button uses (see the onMenu wheel binding) */
		}
	}, [dateTimeLocked, screen]);
```

```tsx
	onPlayPause: () => {
		if (dateTimeLocked) return;
		paused ? resume() : pause();
	},
```

The eviction body must call the shell's real navigation function (the one bound to the wheel's Menu button) — resolve it from `IpodShell.tsx`/`screenStack.ts` when editing; it is an existing one-liner, not new machinery.

- [ ] **Step 4: Run the mobile + full frontend suites**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Mobile/ && pnpm test 2>&1 | tail -3`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Mobile/
git commit -m "feat(mobile): gate Time Travel, scrub, and wheel pause while clock is forced"
```

---

### Task 10: docs + full gates + end-to-end verification

**Files:**
- Modify: `packages/backend/docs/websocket-protocol.md`
- Modify: `packages/backend/SPEC.md`

- [ ] **Step 1: Document the wire changes**

In `websocket-protocol.md`, add a "Forced clock mode" section (place it near the heartbeat section, matching the doc's existing format of example frames + field tables):

````markdown
### Forced clock mode (server → client `clock`, `heartbeat_ack.master_time`)

An operator can force every client onto one master clock via the streamer's
key-guarded REST API (`POST /clock` — see SPEC.md). While active:

- On connect, and on every activate/jump/release, the server pushes:

```json
{ "type": "clock", "active": true, "time": "2001-09-11T13:03:00Z" }
```

  On release the frame is `{ "type": "clock", "active": false }` and clients
  keep ticking from wherever the master left them.

- Every `heartbeat_ack` carries the authoritative time while active:

```json
{ "type": "heartbeat_ack", "time": "2001-09-11T13:03:00Z", "master_time": "2001-09-11T13:03:00Z" }
```

  Clients treat `master_time` presence as the forced-mode signal and correct
  their clock when drift exceeds 2 s (a missed `clock` frame self-heals within
  one heartbeat interval).

- Client-supplied times on `init` and `seek` are clamped to the master time
  (the ack echoes the clamped time); `heartbeat` pins the session clock to
  master; `pause` is acked but not applied. Timezone display is client-local
  and unaffected.
````

In `SPEC.md`, add the REST endpoint to the HTTP surface section:

```markdown
### `GET|POST /clock` — forced clock mode (operator only)

Guarded by the `X-Clock-Key` header (constant-time compare against
`CLOCK_CONTROL_KEY`; unset ⇒ 404, feature off).

- `GET /clock` → `{"active": false}` or `{"active": true, "time": "..."}`
- `POST /clock {"active": true, "time": "2001-09-11T13:03:00Z"}` — enable/jump
- `POST /clock {"active": false}` — release

State persists in Redis (`clock:master`) and fans out across pods via pub/sub
(`clock:master:changed`), so a pod restart mid-session stays forced.
```

- [ ] **Step 2: Full gates, both packages**

```bash
cd packages/backend && go vet ./... && go test ./... 2>&1 | tail -3
cd ../.. && pnpm --filter @rt911/frontend exec tsc -b && pnpm lint 2>&1 | tail -3 && pnpm test 2>&1 | tail -3
```

Expected: all green (0 eslint errors).

- [ ] **Step 3: End-to-end verification (local streamer)**

This is the check that covers Task 5's untested handler wiring:

```bash
# Terminal A — local streamer against dev Postgres/Redis (see packages/backend
# README/.env for the DSNs used in dev; any reachable pair works):
cd packages/backend
CLOCK_CONTROL_KEY=devkey DATABASE_URL=<dev-dsn> REDIS_URL=<dev-redis> go run ./cmd/server

# Terminal B:
curl -s localhost:8080/clock -H 'X-Clock-Key: devkey'                     # {"active":false}
curl -s -X POST localhost:8080/clock -H 'X-Clock-Key: devkey' \
  -d '{"active":true,"time":"2001-09-11T13:03:00Z"}'                      # {"active":true,...}
curl -s localhost:8080/clock                                              # 403 (no key)
```

Then point the frontend dev server's `VITE_MEDIA_STREAM_URL` at `ws://localhost:8080/stream`, load the desktop, and verify with the `packages/frontend:verify` skill: the desktop clock snaps to 9:03 AM ET, Time Machine won't stay open (dialog appears), the Date & Time control panel's date/time editors are greyed while timezone still changes the display, and `POST {"active":false}` re-enables everything with the clock continuing from where the master left it.

If a local streamer isn't feasible (no reachable dev Postgres), STOP and tell the user which parts were verified by tests and that the WS-path clamp needs staging verification after deploy — do not claim E2E verification that didn't happen.

- [ ] **Step 4: Commit**

```bash
git add packages/backend/docs/websocket-protocol.md packages/backend/SPEC.md
git commit -m "docs(streamer): forced clock mode wire protocol + REST API"
```

---

### Task 11: infra follow-up + operator runbook (manual, separate repo)

**Files (in `~/infra`):**
- Modify: `apps/rt911/streamer.yaml`

- [ ] **Step 1: Create the key + wire the env**

```bash
kubectl -n rt911 create secret generic streamer-clock \
  --from-literal=CLOCK_CONTROL_KEY="$(openssl rand -hex 24)"
```

In `apps/rt911/streamer.yaml`, add to the streamer container's `env:`:

```yaml
            - name: CLOCK_CONTROL_KEY
              valueFrom:
                secretKeyRef:
                  name: streamer-clock
                  key: CLOCK_CONTROL_KEY
```

Commit/push to the infra repo main (user's established self-merge flow); ArgoCD rolls the streamer. The `/clock` path is served by the existing streamer route — verify the Ingress/IngressRoute for the streamer host forwards all paths (it forwards `/stream` and `/feedback` today; if it's path-enumerated, add `/clock`).

- [ ] **Step 2: Operator runbook (paste into the PR description / ops notes)**

```bash
KEY=$(kubectl -n rt911 get secret streamer-clock -o jsonpath='{.data.CLOCK_CONTROL_KEY}' | base64 -d)
STREAM=https://<streamer-host>

curl -s "$STREAM/clock" -H "X-Clock-Key: $KEY"                                  # status
curl -s -X POST "$STREAM/clock" -H "X-Clock-Key: $KEY" \
  -d '{"active":true,"time":"2001-09-11T12:46:00Z"}'                            # force everyone to 8:46 ET
curl -s -X POST "$STREAM/clock" -H "X-Clock-Key: $KEY" -d '{"active":false}'    # release
```

- [ ] **Step 3: Post-deploy verification against prod**

Repeat Task 10 Step 3's curl sequence against the deployed host with the real key, with a browser on the live site: clock snaps for the open session, Time Machine locks, release restores control.

---

## Execution notes

- **Order matters at two seams:** Task 2 must be published to npm before Tasks 7–9 typecheck (`dateTimeLocked` in classicy's types); Tasks 3→4→5→6 are strictly sequential (each imports the previous). Tasks 7–9 depend on 4's wire shape but can be built in parallel with 5–6 if needed.
- **The one-writer rule evolves, deliberately:** `MediaStreamProvider` becomes the third sanctioned `setDateTimeFromUtc` caller (after TimeMachine and PlaylistProvider). Update the "one clock writer" paragraph in `packages/frontend/CLAUDE.md` in the same PR if the reviewer flags it — the invariant is now "all writes go through `setDateTimeFromUtc`."
- **rt911 commits run the classicy pre-commit auto-bump** — after Task 2's publish, the first rt911 commit will pull the new classicy version into `pnpm-lock.yaml` on its own; that ride-along is expected.
