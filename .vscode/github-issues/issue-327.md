---
id: 4988764670
number: 327
title: 'Buddies: messages to and from should be sorted by time sent/received'
state: open
created_at: '2026-07-27T14:04:51Z'
updated_at: '2026-07-27T14:41:24Z'
author:
  login: robbiebyrd
  id: 1775127
  avatar_url: 'https://avatars.githubusercontent.com/u/1775127?v=4'
  url: 'https://api.github.com/users/robbiebyrd'
assignees: []
labels: []
url: 'https://api.github.com/repos/Keeping-History/rt911/issues/327'
html_url: 'https://github.com/Keeping-History/rt911/issues/327'
---
# Buddies: messages to and from should be sorted by time sent/received

Currently, messages sent will appear lower down that received messages. They should appear in the order they were transmitted.

---

**Author:** @robbiebyrd
**Created:** 2026-07-27T14:04:51Z
**Updated:** 2026-07-27T14:41:24Z

---

## Comments

### @robbiebyrd - 2026-07-27T14:38:29Z

## Root cause (hypothesis — worth confirming before fixing)

Messages are sorted by `(virtual_time, message_id, arrival index)` in `IMBuddiesProvider.tsx`'s `conversationsByProfile`. The two sides of a conversation are stamped at **different time resolutions**:

- The server formats with `time.RFC3339` — **whole seconds**, no fractional part (`packages/backend/internal/session/session.go:1009`, and the same on the stall and static-beat frames).
- Your own message is echoed locally with `new Date(virtualNowMs).toISOString()` — **milliseconds**.

So an exchange landing inside the same virtual second compares your `12:41:03.250Z` against the buddy's `12:41:03.000Z`, and yours sorts *after* theirs. That is precisely "messages sent appear lower down than received messages."

## Why the tiebreak does not save it

When the times differ at all, the comparator returns on time and never reaches the tiebreak. And the tiebreak itself is wrong for this case anyway: it compares `message_id`, but a local echo carries `message_id: 0` (the server's "not persisted" marker) — 0 against a real id is not a statement about time, it just sorts every unsent-yet-unpersisted line to the top.

## Plan

1. **Confirm first.** Send a message, capture the two `time` values as they arrive, and check they land in the same second with only the local one carrying milliseconds. If they do not, this hypothesis is wrong and the fix below is wrong with it.
2. Stamp the local echo at the wire's resolution — floor to whole seconds — so the two sides are comparable at all.
3. Change the tiebreak from `message_id` to **arrival index**, which is transmission order and is what this issue actually asks for. Within one second, "the order they were transmitted" is the order the client saw them.
4. Re-check the history-replay path: after a backward seek the array is cleared before the replay, so arrival index equals the server's oldest-first order and stays correct.

## Test

Two messages in the same virtual second — one sent (`message_id: 0`, millisecond stamp), one received (whole-second stamp) — must render in transmission order. Mutation-check it by restoring the millisecond stamp; the test must fail.


### @robbiebyrd - 2026-07-27T14:41:24Z

## Hypothesis confirmed

@robbiebyrd confirms the timestamp-resolution mismatch. Proceeding with the plan above:

1. Stamp the local echo at whole-second resolution to match `time.RFC3339` on the wire.
2. Change the tiebreak from `message_id` to arrival index — transmission order, which is what this issue asks for. `message_id: 0` on a local echo is a "not persisted" marker, not a position in time, and using it as one sorts every unsent line to the top.
3. Keep the history-replay path correct: the array is cleared before a backward-seek replay, so arrival index equals the server's oldest-first order.

Step 1 of the original plan (capture two live timestamps) is satisfied by that confirmation.


