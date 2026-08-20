// Pure reduction of a virtual-clock UTC instant over the market calendar.
// Callers must pass true UTC ms (virtualUtcMs), never localDate.getTime() —
// see Providers/MediaStream/virtualClock.ts.

import type { MarketCalendar, MarketClosure, MarketSession } from './types'

export type MarketState =
    | { state: 'open'; session: MarketSession }
    | { state: 'halted'; closure: MarketClosure }
    | { state: 'closed' }

// A closure outranks the session grid: 9/11's scheduled open never rang.
// Boundaries: closure end and session open are inclusive starts ([start, end)),
// so 9/17 13:30:00Z is already "open", not still "halted".
export function marketState(utcMs: number, cal: MarketCalendar): MarketState {
    const closure = cal.closures.find((c) => utcMs >= Date.parse(c.start) && utcMs < Date.parse(c.end))
    if (closure) return { state: 'halted', closure }
    const session = cal.sessions.find((s) => utcMs >= Date.parse(s.open) && utcMs < Date.parse(s.close))
    if (session) return { state: 'open', session }
    return { state: 'closed' }
}

// Which day's bars the boards should show: the in-progress session, otherwise
// the most recently *started* one (a frozen tape shows the last prints). Null
// before the first session in range.
export function displaySessionDate(utcMs: number, cal: MarketCalendar): string | null {
    let latest: string | null = null
    for (const s of cal.sessions) {
        if (utcMs >= Date.parse(s.open)) latest = s.date
    }
    return latest
}
