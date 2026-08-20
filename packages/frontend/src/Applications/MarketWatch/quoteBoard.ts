// What does each symbol's quote line read at virtual instant T?
// Pure: (symbol data, true-UTC ms, calendar) → displayed quote. The board and
// the ticker tape both consume this, so open/halted/closed price logic lives
// in exactly one place.

import { displaySessionDate, marketState } from './marketClock'
import { buildIntradayPath, priceAtMinute } from './syntheticIntraday'
import type { DailyBar, MarketData, MarketSymbol, MarketTag } from './types'

export interface Quote {
    symbol: string
    name: string
    tags: MarketTag[]
    unit: 'usd' | 'percent'
    last: number
    /** vs the prior session's close; null when there is no prior bar */
    change: number | null
    pctChange: number | null
}

// Deterministic paths are safe to cache for the lifetime of the page.
const pathCache = new Map<string, number[]>()

function sessionPath(symbol: string, bar: DailyBar, minutes: number): number[] {
    const key = `${symbol}|${bar.date}|${minutes}`
    let path = pathCache.get(key)
    if (!path) {
        path = buildIntradayPath(symbol, bar, minutes)
        pathCache.set(key, path)
    }
    return path
}

export function computeQuote(sym: MarketSymbol, utcMs: number, calendar: MarketData['calendar']): Quote | null {
    const cal = calendar[sym.market]
    const sessionDate = displaySessionDate(utcMs, cal)
    if (sessionDate === null) return null

    // The bar for the display session, or the freshest one before it (sources
    // occasionally miss a day; a stale print beats a blank line).
    let barIndex = -1
    for (let i = 0; i < sym.bars.length; i++) {
        if (sym.bars[i].date <= sessionDate) barIndex = i
    }
    if (barIndex === -1) return null
    const bar = sym.bars[barIndex]
    const prior = barIndex > 0 ? sym.bars[barIndex - 1] : null

    let last = bar.close
    const state = marketState(utcMs, cal)
    // Yields step daily (unit "percent"); equities move along the synthetic path.
    if (state.state === 'open' && sym.unit === 'usd' && bar.date === state.session.date) {
        const openMs = Date.parse(state.session.open)
        const minutes = Math.round((Date.parse(state.session.close) - openMs) / 60_000)
        const minute = Math.floor((utcMs - openMs) / 60_000)
        last = priceAtMinute(sessionPath(sym.symbol, bar, minutes), minute)
    }

    return {
        symbol: sym.symbol,
        name: sym.name,
        tags: sym.tags,
        unit: sym.unit,
        last,
        change: prior ? last - prior.close : null,
        pctChange: prior ? ((last - prior.close) / prior.close) * 100 : null,
    }
}
