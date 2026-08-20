# RadioScanner Focused-Player Progress Slider — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a seekable progress/duration slider to the RadioScanner focused player (`rsFocusedPlayer` / `FocusedItemPlayer`), modeled on classicy's QuickTime Movie Player.

**Architecture:** A new pure presentational component `RadioProgressBar` renders a `<input type="range">` bound to `currentTime / duration` plus a `timeFriendly` elapsed/total readout, and reports drags back via an `onSeekPct` callback. `FocusedItemPlayer` owns the audio element, mirrors its native `timeupdate`/`loadedmetadata`/`durationchange`/`ended` events into React state, and turns an `onSeekPct` fraction into `audio.currentTime = pct * duration`. The player is independent of the virtual clock, so no `setDateTimeFromUtc` seam is involved.

**Tech Stack:** Vite + React + TypeScript, Vitest + `@testing-library/react`, SCSS modules, `classicy` (`timeFriendly` helper).

## Global Constraints

- `classicy` is pinned to `"latest"`; never hand-edit its version (`.husky/pre-commit` auto-bumps it). Installed build is `classicy@0.54.0`, which exports `timeFriendly`.
- Apps never open a WebSocket or write the virtual clock directly — N/A here; the focused player uses a plain `<audio>` element and does not touch the clock.
- Co-locate tests next to source; there is **no global test setup**, so every test file calls `afterEach(cleanup)` itself.
- Frontend verification commands (run from repo root): `pnpm --filter @rt911/frontend exec vitest run <path>`, `pnpm build` (tsc -b + vite build), `pnpm lint` (eslint .).
- Prefer `Number.parseFloat` over the global `parseFloat`.

---

### Task 1: `RadioProgressBar` pure component + styles

**Files:**
- Create: `packages/frontend/src/Applications/RadioScanner/RadioProgressBar.tsx`
- Create: `packages/frontend/src/Applications/RadioScanner/RadioProgressBar.test.tsx`
- Modify: `packages/frontend/src/Applications/RadioScanner/RadioScanner.module.scss` (append new classes after the existing `.rsFocusedControls` block, ~line 357)

**Interfaces:**
- Consumes: `timeFriendly(seconds: number): string` from `classicy`; SCSS-module class names from `RadioScanner.module.scss`.
- Produces:
  ```ts
  interface RadioProgressBarProps {
    currentTime: number;            // seconds elapsed
    duration: number;               // seconds total (0 when unknown)
    onSeekPct: (pct: number) => void; // pct in [0, 1]
  }
  export const RadioProgressBar: React.FC<RadioProgressBarProps>;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/frontend/src/Applications/RadioScanner/RadioProgressBar.test.tsx`:

```tsx
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RadioProgressBar } from "./RadioProgressBar";

afterEach(cleanup);

describe("RadioProgressBar", () => {
	it("derives the slider value from currentTime / duration", () => {
		const { container } = render(
			<RadioProgressBar currentTime={30} duration={120} onSeekPct={() => {}} />,
		);
		const input = container.querySelector("input") as HTMLInputElement;
		expect(input.value).toBe("0.25");
	});

	it("shows 0 and does not divide by zero when duration is 0", () => {
		const { container } = render(
			<RadioProgressBar currentTime={5} duration={0} onSeekPct={() => {}} />,
		);
		const input = container.querySelector("input") as HTMLInputElement;
		expect(input.value).toBe("0");
	});

	it("formats an elapsed / total readout", () => {
		const { getByText } = render(
			<RadioProgressBar currentTime={65} duration={125} onSeekPct={() => {}} />,
		);
		expect(getByText("0:01:05 / 0:02:05")).not.toBeNull();
	});

	it("reports the dragged fraction through onSeekPct", () => {
		const onSeekPct = vi.fn();
		const { container } = render(
			<RadioProgressBar currentTime={0} duration={100} onSeekPct={onSeekPct} />,
		);
		const input = container.querySelector("input") as HTMLInputElement;
		fireEvent.change(input, { target: { value: "0.5" } });
		expect(onSeekPct).toHaveBeenCalledWith(0.5);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/RadioScanner/RadioProgressBar.test.tsx`
Expected: FAIL — cannot resolve `./RadioProgressBar` (module not found).

- [ ] **Step 3: Write the component**

Create `packages/frontend/src/Applications/RadioScanner/RadioProgressBar.tsx`:

```tsx
import { timeFriendly } from "classicy";
import type React from "react";
import styles from "./RadioScanner.module.scss";

interface RadioProgressBarProps {
	currentTime: number;
	duration: number;
	onSeekPct: (pct: number) => void;
}

/**
 * Seekable progress/duration slider for the RadioScanner focused player.
 * Pure and props-only: the owning FocusedItemPlayer feeds it the audio
 * element's currentTime/duration and turns onSeekPct back into a seek.
 */
export const RadioProgressBar: React.FC<RadioProgressBarProps> = ({
	currentTime,
	duration,
	onSeekPct,
}) => (
	<div className={styles.rsFocusedProgress}>
		<input
			type="range"
			className={styles.rsFocusedProgressBar}
			min={0}
			max={1}
			step={0.001}
			value={duration > 0 ? currentTime / duration : 0}
			aria-label="Seek"
			onChange={(e) => onSeekPct(Number.parseFloat(e.target.value))}
		/>
		<p className={styles.rsFocusedTime}>
			{timeFriendly(currentTime)} / {timeFriendly(duration)}
		</p>
	</div>
);
```

- [ ] **Step 4: Add the styles**

Append to `packages/frontend/src/Applications/RadioScanner/RadioScanner.module.scss` after the `.rsFocusedControls { … }` block (~line 357):

```scss
.rsFocusedProgress {
  display: flex;
  flex-direction: column;
  gap: calc(var(--window-padding-size) / 2);
  z-index: 9;
}

.rsFocusedProgressBar {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 6px;
  border-radius: 3px;
  background: var(--color-system-05);
  cursor: pointer;

  &::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--color-theme-01);
    border: 1px solid var(--color-system-05);
  }

  &::-moz-range-thumb {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--color-theme-01);
    border: 1px solid var(--color-system-05);
  }
}

.rsFocusedTime {
  font-family: var(--ui-font);
  font-size: calc(var(--ui-font-size) * 0.75);
  color: var(--color-theme-02);
  letter-spacing: 0.05em;
  margin: 0;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/RadioScanner/RadioProgressBar.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/Applications/RadioScanner/RadioProgressBar.tsx \
        packages/frontend/src/Applications/RadioScanner/RadioProgressBar.test.tsx \
        packages/frontend/src/Applications/RadioScanner/RadioScanner.module.scss
git commit -m "feat(radioscanner): RadioProgressBar seekable duration slider"
```

---

### Task 2: Wire the slider into `FocusedItemPlayer`

**Files:**
- Modify: `packages/frontend/src/Applications/RadioScanner/FocusedItemPlayer.tsx`
- Test: `packages/frontend/src/Applications/RadioScanner/FocusedItemPlayer.test.tsx` (extend)

**Interfaces:**
- Consumes: `RadioProgressBar` from Task 1 (`{ currentTime, duration, onSeekPct }`).
- Produces: no new exported surface; `FocusedItemPlayer`'s props are unchanged.

- [ ] **Step 1: Write the failing tests**

In `packages/frontend/src/Applications/RadioScanner/FocusedItemPlayer.test.tsx`, change the import line

```tsx
import { cleanup, render } from "@testing-library/react";
```

to

```tsx
import { cleanup, fireEvent, render } from "@testing-library/react";
```

Then add these two tests inside the `describe("FocusedItemPlayer", …)` block:

```tsx
	it("tracks duration, advances on timeupdate, and seeks via the slider", () => {
		const { container } = render(
			<FocusedItemPlayer
				item={item({})}
				onDismiss={() => {}}
				showWaveform={false}
				vizMode="Wave"
				onCycleVizMode={() => {}}
				waveColors={null}
				maxVolume={1}
			/>,
		);
		const el = container.querySelector("audio") as HTMLAudioElement;
		Object.defineProperty(el, "duration", { configurable: true, get: () => 200 });
		const input = () => container.querySelector("input") as HTMLInputElement;

		fireEvent.loadedMetadata(el);
		expect(input().value).toBe("0");

		el.currentTime = 50;
		fireEvent.timeUpdate(el);
		expect(input().value).toBe("0.25");

		fireEvent.change(input(), { target: { value: "0.5" } });
		expect(el.currentTime).toBe(100);
	});

	it("returns the button to Play when the clip ends", async () => {
		const { container, findByText, getByText } = render(
			<FocusedItemPlayer
				item={item({})}
				onDismiss={() => {}}
				showWaveform={false}
				vizMode="Wave"
				onCycleVizMode={() => {}}
				waveColors={null}
				maxVolume={1}
			/>,
		);
		// The mount effect calls play() (mocked to resolve) → button shows Pause.
		await findByText("Pause");
		const el = container.querySelector("audio") as HTMLAudioElement;
		fireEvent.ended(el);
		expect(getByText("Play")).not.toBeNull();
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/RadioScanner/FocusedItemPlayer.test.tsx`
Expected: FAIL — no `<input>` in the tree (first test); button stays "Pause"/no seek handling (second test).

- [ ] **Step 3: Add state, event handlers, and seek logic**

In `packages/frontend/src/Applications/RadioScanner/FocusedItemPlayer.tsx`:

3a. Add the import near the other local imports (below the `WaveformVisualizer` import, line 15):

```tsx
import { RadioProgressBar } from "./RadioProgressBar";
```

3b. Add state next to the existing `playing`/`readyVersion` state (after line 45):

```tsx
	const [currentTime, setCurrentTime] = useState(0);
	const [duration, setDuration] = useState(0);
```

3c. Add the seek helper next to `togglePlay` (after the `togglePlay` definition, ~line 76):

```tsx
	const seekToPct = (pct: number) => {
		const el = audioRef.current;
		if (!el) return;
		const seconds = pct * (el.duration || 0);
		el.currentTime = seconds;
		setCurrentTime(seconds);
	};
```

3d. Replace the existing `<audio …>` element (lines 85–91) with one that mirrors its events into state:

```tsx
			<audio
				ref={audioRef}
				src={item.url}
				crossOrigin="anonymous"
				style={{ display: "none" }}
				onLoadedMetadata={() => {
					setReadyVersion((v) => v + 1);
					setDuration(audioRef.current?.duration ?? 0);
				}}
				onDurationChange={() => setDuration(audioRef.current?.duration ?? 0)}
				onTimeUpdate={() => setCurrentTime(audioRef.current?.currentTime ?? 0)}
				onEnded={() => setPlaying(false)}
			/>
```

3e. Render the slider between the waveform block and the `rsFocusedControls` div. Insert this immediately before `<div className={styles.rsFocusedControls}>` (~line 108):

```tsx
			<RadioProgressBar
				currentTime={currentTime}
				duration={duration}
				onSeekPct={seekToPct}
			/>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/RadioScanner/FocusedItemPlayer.test.tsx`
Expected: PASS (all existing tests plus the two new ones).

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/RadioScanner/FocusedItemPlayer.tsx \
        packages/frontend/src/Applications/RadioScanner/FocusedItemPlayer.test.tsx
git commit -m "feat(radioscanner): show seekable progress in the focused player"
```

---

### Task 3: Full verification (unit + typecheck + lint + runtime)

**Files:** none (verification only).

- [ ] **Step 1: Run the RadioScanner test suite**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/RadioScanner/`
Expected: PASS — all RadioScanner specs green.

- [ ] **Step 2: Typecheck + build**

Run: `pnpm build`
Expected: `tsc -b` and `vite build` complete with no errors.

- [ ] **Step 3: Lint**

Run: `pnpm lint`
Expected: no errors in the new/modified files.

- [ ] **Step 4: Runtime check (optional but recommended)**

Use the `packages/frontend:verify` skill to drive the dev server: open RadioScanner, click a past item to enter the focused player, and confirm the slider fills as the clip plays, the elapsed/total readout ticks, and dragging the thumb jumps playback. Verify in both light and dark scanner themes.

---

## Self-Review

**Spec coverage:**
- Seekable slider modeled on QuickTime → Task 1 (`RadioProgressBar`, `onSeekPct`) + Task 2 (`seekToPct`). ✅
- Bar + elapsed/total time readout, reusing `timeFriendly` → Task 1. ✅
- Scanner-native styling in `RadioScanner.module.scss`, Safari thumb styling → Task 1 Step 4. ✅
- `timeupdate`→state mirroring (currentTime not reactive) → Task 2 Step 3d. ✅
- Duration from `loadedmetadata`/`durationchange`; `onEnded`→Play → Task 2 Step 3d. ✅
- `RadioProgressBar` pure/independently testable → Task 1 test. ✅
- Not reusing `QuickTimeSeekBar` (own markup) → Task 1 component uses a bare `<input>`. ✅
- Out of scope (StationPlayer, ±10s buttons, persistence) → untouched. ✅

**Placeholder scan:** No TBD/TODO; all steps contain concrete code and commands. ✅

**Type consistency:** `RadioProgressBar` props `{ currentTime, duration, onSeekPct }` are identical in the component (Task 1), its test (Task 1), and the call site (Task 2 Step 3e). `seekToPct(pct)` fraction → `pct * duration` seconds is consistent between Task 2 helper and both tests. ✅
