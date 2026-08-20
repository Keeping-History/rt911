# Alerts Manager — design

Date: 2026-07-20
Status: approved

## What

A new Classicy app, **Alerts Manager** (`AlertsManager.app`), modeled on Classicy's
built-in Date and Time Manager control panel. It has **no desktop icon** but
appears in the **Apple menu** (`noDesktopIcon={true}` + `addSystemMenu={true}`),
and presents a single checkbox — **"Show Alerts"** — that turns the Alerts
extension's modals on or off desktop-wide.

## Why

The Alerts extension (`packages/frontend/src/Applications/Alerts/Alerts.tsx`) is a
silent background extension that pops a `ClassicyAlert` modal whenever the virtual
clock crosses an `alert_items` row's `start_date`. There is currently no way for a
user to opt out of these interruptions. A control panel in the Apple menu — the
Mac OS 8 place for system-wide settings — is the idiomatic fix.

## Decisions (user-approved)

1. **Skip missed alerts.** While alerts are off, the extension **unsubscribes**
   from the `alerts` WebSocket channel entirely (no traffic). The channel is
   fire-on-cross / no-snapshot, so alerts whose moment passes during the off
   window never show, matching the product's live-broadcast semantics.
2. **Persist the setting.** The flag survives reloads via `localStorage`
   (key `rt911AlertsEnabled`). Default is **on**.
3. **Shared state lives in a tiny rt911-local store** (Approach A below), not in
   Classicy state or MediaStreamContext.

### Approaches considered

- **A (chosen): rt911-local external store.** ~30-line module with
  `useSyncExternalStore` + `localStorage`. Both the manager (writer) and the
  extension (reader) import the same hook. No classicy release, no provider
  re-renders, trivially testable.
- **B: extend Classicy app-manager state** with a generic app-data event riding
  `classicyDesktopState` persistence. Idiomatic but needs a classicy release +
  version bump for one boolean — overkill.
- **C: flag in MediaStreamContext.** The provider owns alert plumbing, but this
  is a UI preference, not stream state, and toggling would re-render every
  stream consumer.

## Components

All new code lives beside the extension in
`packages/frontend/src/Applications/Alerts/`.

### `alertsSettings.ts` (new)

External store for one boolean:

- `getAlertsEnabled(): boolean` — reads cache; first read hydrates from
  `localStorage` inside try/catch (private-mode Safari throws → default `true`).
  Any value other than the literal `"false"` means enabled.
- `setAlertsEnabled(v: boolean): void` — updates cache, best-effort persists,
  notifies subscribers.
- `useAlertsEnabled(): boolean` — `useSyncExternalStore` over the above.

### `AlertsManager.tsx` (new)

Structure copied from `ClassicyDateAndTimeManager`:

- `APP_ID = "AlertsManager.app"`, `APP_NAME = "Alerts Manager"`, one window
  `AlertsManager_1`.
- `ClassicyApp` props: `noDesktopIcon={true}`, `addSystemMenu={true}`,
  `defaultWindow="AlertsManager_1"` → Apple-menu entry, no desktop icon.
- Small fixed-size, non-resizable `ClassicyWindow` containing a
  `ClassicyControlGroup` ("Alerts") with one `ClassicyCheckbox`
  ("Show Alerts") bound to the store, plus a Quit `ClassicyButton`.
- App menu: File (About / Close Window ⌥W / spacer / Quit ⌥Q) + Edit, via the
  same `useClassicyAboutMenu` / `useClassicyWindowClose` / `useClassicyEditMenu`
  hooks and helpers the Date and Time Manager uses.
- Icon: reuse a bundled `ClassicyIcons` control-panel icon (rendered in the
  Apple menu and About window only).

### `Alerts.tsx` (changed)

- Read `const enabled = useAlertsEnabled()`.
- Subscribe effect gates on `isRunning && enabled`; toggling off runs the
  cleanup → `unsubscribeAlerts(appId)`, which (as the last subscriber, since
  `Alerts.app` is the alerts channel's only subscriber) sends the channel
  unsubscribe and clears **both** the un-revealed buffer and the revealed
  `alertItems` list (`setAlertItems([])`, `MediaStreamProvider.tsx:484-487`).
- Modal renders only when `enabled` — a visible alert disappears the instant
  the user toggles off. It is *not* auto-dismissed, but because
  `unsubscribeAlerts` clears `alertItems` entirely, an alert visible at
  toggle-off is dropped permanently rather than merely hidden: re-enabling
  within the same session does **not** bring it back, since nothing remains
  in `alertItems` to re-render and the channel is fire-on-cross with no
  snapshot to re-deliver it. This is intended and consistent with the
  approved "skip missed alerts" semantics — the user never acknowledged it,
  and the product treats a missed alert the same whether alerts were off when
  it fired or the user simply didn't see it before toggling off.

### `Desktop.tsx` (changed)

Mount `<AlertsManager />` alongside the other apps.

## Data flow

```
ClassicyCheckbox ──setAlertsEnabled──▶ alertsSettings store ──▶ localStorage
                                            │
                              useAlertsEnabled() (useSyncExternalStore)
                                            ▼
                       Alerts.tsx effect: subscribe/unsubscribe + render gate
```

## Error handling

- `localStorage` get/set wrapped in try/catch; failures degrade to in-memory
  session behavior with default on.
- No new WS message types; unsubscribe path already exists and is idempotent.

## Testing

Vitest, following the existing Alerts.test.tsx mocking pattern (and the
project's no-auto-cleanup rule — `afterEach(cleanup)` in new files):

1. `alertsSettings.test.ts` — default true; persists and re-hydrates; notifies
   subscribers; tolerates throwing localStorage.
2. `AlertsManager.test.tsx` — checkbox reflects store; clicking flips store;
   app registers with `noDesktopIcon` + system menu props.
3. `Alerts.test.tsx` (extend) — disabled → no `subscribeAlerts`, no modal;
   toggle off while modal visible → modal unmounts and `unsubscribeAlerts`
   called; re-enable → `subscribeAlerts` called again.

## Out of scope

- Muting the existing in-app `ClassicyAlert`s other apps raise (this gates only
  the Alerts extension's stream-driven modals).
- Any backend/streamer change.
- Mobile (iPod shell) — the extension is desktop-only today.
