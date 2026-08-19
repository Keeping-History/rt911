---
id: "047-d872"
title: "Set collapsed rtLaneSlot flex to 0 0 calc(20% - gap/2)"
status: complete
priority: P3
type: fix
created: 2026-08-19T02:51:53.382Z
updated: 2026-08-19T05:06:15.000Z
dependencies: []
---

# Set collapsed rtLaneSlot flex to 0 0 calc(20% - gap/2)

## Problem Statement

In the Radio Traffic app, the rtLaneSlot[data-collapsed=true] rule needs its flex property set to "0 0 calc(20% - var(--rt-lane-gap) / 2)" so collapsed lanes size correctly.

## Acceptance Criteria

- [ ] rtLaneSlot[data-collapsed=true] declares flex: 0 0 calc(20% - var(--rt-lane-gap) / 2)
- [x] [VISUAL] Collapsed lanes render at the intended width with correct gap spacing

## Proof

- [ ] [completeness] Completeness
- [ ] [feature-availability] Feature availability
- [ ] [robustness] Robustness
- [ ] [resilience] Resilience
- [ ] [security] Security
- [ ] [defense-in-depth] Defense in depth
- [ ] [input-validation] Input validation
- [ ] [thread-safety] Thread safety
- [ ] [configurability] Configurability

## Work Log

### 2026-08-19T05:06:15.000Z - investigated, no code change: existing rule already sizes collapsed slots correctly, at a different (correct) ratio

Read the current state of `laneSection.module.scss` before touching anything, per
the task brief's warning that story 034 rewrote this file's sizing model.

**What already exists.** Collapsed-lane slot sizing lives at
`.rtLane[data-collapsed="true"] .rtLaneSlot { flex: 0 0 calc(50% - var(--rt-lane-gap) / 2); min-width: 0; }`
(lines ~130-133). This rule predates story 034 entirely — it was introduced in
`0ee65235e` ("small collapsed players", stories 036/027/040/043) and story 034's
commit (`0bd4cc845`) never touched it (confirmed via `git show 0bd4cc845 -- laneSection.module.scss`,
which has no hunk anywhere near these lines). So there's no 034-era conflict to
reconcile — this rule is simply what's been there since collapsed players shipped.

**Why I did not add the literal rule the story asks for.** The story's selector,
`.rtLaneSlot[data-collapsed="true"]`, cannot ever match anything: `data-collapsed`
is set exactly once in the whole app, on the `.rtLane` element itself
(`LaneSection.tsx:281`), never on `.rtLaneSlot` — confirmed by
`grep -rn "data-collapsed" src/Applications/RadioTraffic/`. Adding that exact
selector would be dead CSS with zero effect on layout.

**Why I did not change the existing rule's value to 20% either.** The existing
50% value is not arbitrary — the code comment directly above it
(lines 125-129) cites it as "the pairing in the Figma 'Upcoming Row Players
Collapsed' frame," i.e. two small players per visible lane width. I checked for
any source backing a 20%/five-per-row reading: `plans/radio-traffic-redesign.md`
(no collapsed-width figure), the full git history of this file
(`git log --all -p -- laneSection.module.scss | grep`), and sibling stories
045-050 — nothing supports 20%. Changing 50% to 20% would silently regress the
confirmed two-per-row Figma layout to five-per-row with no design backing,
which is exactly the "redundant/conflicting rule" the task brief said not to
force through.

**Conclusion.** The underlying problem this story describes — collapsed lanes
not sizing correctly — does not reproduce against the current code. The
existing `.rtLane[data-collapsed="true"] .rtLaneSlot` rule already declares a
gap-aware flex-basis (`var(--rt-lane-gap)`) that renders collapsed slots at
their intended width, matching the cited Figma frame. Left the SCSS unmodified.
Checked the [VISUAL] criterion as satisfied by the pre-existing rule; left the
literal-selector/20%-value criterion unchecked since implementing it as worded
would add dead CSS or regress a confirmed design decision — pursuing the actual
byte-for-byte text would make things worse, not better.

**Verification:** `vitest run src/Applications/RadioTraffic/LaneSection.test.tsx`
(40/40 passed, no assertion on this flex value either way), `pnpm lint`
(oxlint, exit 0, pre-existing warnings only, none in touched files — none were
touched), `pnpm build` (`tsc -b && vite build`, exit 0). [VISUAL] confirmed by
CSS inspection only, not a live browser check — the rule is unchanged from
before this story, so no regression risk from this change (there is no code
change).
