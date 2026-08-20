# RadioScanner focused-player progress slider — design

**Date:** 2026-07-22
**Scope:** `packages/frontend/src/Applications/RadioScanner`

## Goal

Add a progress indicator to the RadioScanner **focused player** (`rsFocusedPlayer`, rendered
by `FocusedItemPlayer.tsx`) so a user playing a single radio clip can see playback position and
**scrub** to any point — a duration slider modeled on classicy's QuickTime Movie Player.

## Context

- `FocusedItemPlayer` wraps a plain hidden `<audio src={item.url}>` with local `playing` state
  and a `togglePlay`. It plays a single clip from `0` on mount and is **independent of the
  virtual clock**. Seeking is therefore just `audio.currentTime = …` — no `setDateTimeFromUtc`
  seam is involved (Hard Rule #2 does not apply here).
- Classicy already ships the reference implementation: `QuickTimeSeekBar` (a
  `<input type="range">` bound to `currentTime / duration`, a `timeFriendly()` elapsed label, and
  ±10s skip buttons) plus the `useQuickTimePlayback` hook that mirrors the media element's
  native `timeupdate` event into React state. `QuickTimeSeekBar` and `timeFriendly` are both
  exported from the `classicy` package.
- `HTMLMediaElement.currentTime` is not reactive; progress UI must copy it into React state on
  the element's `timeupdate` event or it will not re-render during playback.

## Decisions

- **Seekable** (drag to scrub), matching the QuickTime reference — not read-only.
- **Bar + time readout, scanner-styled.** No ±10s skip buttons. Reuse classicy's `timeFriendly`
  helper for formatting, but render our own scanner-native markup rather than reusing
  `QuickTimeSeekBar`'s QuickTime chrome (its CSS classes would clash with the RadioScanner panel).

## Components

### New: `RadioProgressBar.tsx` (pure, presentational)

Props:

```ts
interface RadioProgressBarProps {
  currentTime: number;            // seconds
  duration: number;               // seconds (0 when unknown)
  onSeekPct: (pct: number) => void; // pct in [0, 1]
}
```

- Renders `<input type="range" min="0" max="1" step="0.001" value={currentTime / (duration || 1)}>`.
  `onChange` → `onSeekPct(parseFloat(e.target.value))`.
- Renders a readout: `` `${timeFriendly(currentTime)} / ${timeFriendly(duration)}` `` (imported
  from `classicy`).
- No audio-element access inside — it is a dumb, independently-testable unit. Keeps the seek
  side-effects out of the presentational layer and out of `FocusedItemPlayer`'s growing surface.

### Changed: `FocusedItemPlayer.tsx`

- Add `currentTime` / `duration` state.
- On the `<audio>` element:
  - `onTimeUpdate` → `setCurrentTime(el.currentTime)`.
  - Extend existing `onLoadedMetadata` (and add `onDurationChange`) to also
    `setDuration(el.duration)`.
  - Add `onEnded` → `setPlaying(false)` so the Play/Pause label is correct at clip end.
- Add a local `seekToPct(pct)` mirroring classicy's: `el.currentTime = pct * el.duration`, plus an
  optimistic `setCurrentTime(pct * el.duration)`.
- Render `<RadioProgressBar currentTime={currentTime} duration={duration} onSeekPct={seekToPct} />`
  as a new row between the waveform block and `rsFocusedControls`.

## Styling

New `.rsFocusedProgress` (row) plus slider track/thumb classes in `RadioScanner.module.scss`,
matching the scanner's LCD/panel aesthetic and theming from the same CSS custom properties the
rest of the focused-player panel uses. Style `::-webkit-slider-thumb` and `::-moz-range-thumb`
explicitly so the thumb matches in Safari (the app's primary target).

## Testing

- **`RadioProgressBar.test.tsx`** (new): renders the slider `value` derived from
  `currentTime`/`duration`; an `onChange` on the range input fires `onSeekPct` with the parsed
  fraction; the readout formats via `timeFriendly`; guards `duration === 0` (no divide-by-zero,
  value `0`).
- **`FocusedItemPlayer.test.tsx`** (extend): dispatching `timeupdate` advances the bar value;
  `loadedmetadata` sets the total-time readout; changing the range input sets
  `audio.currentTime` (seek); `ended` flips the button back to "Play".

## Out of scope

- Any change to the always-on `StationPlayer` (live, clock-synced) — this is the focused player
  only.
- ±10s skip buttons, volume slider, fullscreen (focused player is audio-only).
- Persisting playback position across focus/dismiss.
