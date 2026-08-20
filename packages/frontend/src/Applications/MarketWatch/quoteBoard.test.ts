import { describe, expect, it } from 'vitest'

import { computeQuote } from './quoteBoard'
import { buildIntradayPath, priceAtMinute } from './syntheticIntraday'
import type { MarketData, MarketSymbol } from './types'

const day = (d: string, open: string, close: string) => ({
    date: d,
    open: `${d}T${open}:00Z`,
    close: `${d}T${close}:00Z`,
})

const CALENDAR: MarketData['calendar'] = {
    equity: {
        sessions: ['2001-09-06', '2001-09-07', '2001-09-10', '2001-09-17', '2001-09-18'].map((d) =>
            day(d, '13:30', '20:00'),
        ),
        closures: [{ start: '2001-09-11T12:46:00Z', end: '2001-09-17T13:30:00Z', reason: 'closed since 1933' }],
    },
    bond: {
        sessions: ['2001-09-06', '2001-09-07', '2001-09-10', '2001-09-13', '2001-09-14', '2001-09-17'].map((d) =>
            day(d, '12:00', '21:00'),
        ),
        closures: [{ start: '2001-09-11T12:46:00Z', end: '2001-09-13T12:00:00Z', reason: 'bond closed' }],
    },
}

const bar = (date: string, close: number, spread = 1) => ({
    date,
    open: close - spread / 2,
    high: close + spread,
    low: close - spread,
    close,
})

const LUV: MarketSymbol = {
    symbol: 'LUV',
    name: 'Southwest Airlines',
    tags: ['airline'],
    unit: 'usd',
    market: 'equity',
    source: 'yahoo:LUV',
    bars: [bar('2001-09-06', 16.5), bar('2001-09-07', 16.9), bar('2001-09-10', 17.12), bar('2001-09-17', 14.0), bar('2001-09-18', 13.5)],
}

const US10Y: MarketSymbol = {
    symbol: 'US10Y',
    name: '10-Yr Treasury Yield',
    tags: ['bond'],
    unit: 'percent',
    market: 'bond',
    source: 'fred:DGS10',
    bars: [
        { date: '2001-09-06', close: 4.86 },
        { date: '2001-09-07', close: 4.8 },
        { date: '2001-09-10', close: 4.84 },
        { date: '2001-09-13', close: 4.64 },
        { date: '2001-09-14', close: 4.57 },
        { date: '2001-09-17', close: 4.63 },
    ],
}

const at = (iso: string) => Date.parse(iso)

describe('computeQuote', () => {
    it('shows the synthetic intraday price during an open session', () => {
        // 14:30Z on 9/10 = minute 60 of the session
        const q = computeQuote(LUV, at('2001-09-10T14:30:00Z'), CALENDAR)
        const path = buildIntradayPath('LUV', LUV.bars[2], 390)
        expect(q?.last).toBe(priceAtMinute(path, 60))
        expect(q?.change).toBeCloseTo(q!.last - 16.9, 10) // vs 9/7 close
    })

    it('opens the session exactly at the open print', () => {
        const q = computeQuote(LUV, at('2001-09-10T13:30:00Z'), CALENDAR)
        expect(q?.last).toBe(LUV.bars[2].open)
    })

    it('shows the prior close over the weekend', () => {
        const q = computeQuote(LUV, at('2001-09-09T15:00:00Z'), CALENDAR)
        expect(q?.last).toBe(16.9) // 9/7 close
        expect(q?.change).toBeCloseTo(16.9 - 16.5, 10) // vs 9/6
        expect(q?.pctChange).toBeCloseTo(((16.9 - 16.5) / 16.5) * 100, 10)
    })

    it('freezes on the 9/10 close through the halt', () => {
        const q = computeQuote(LUV, at('2001-09-12T16:00:00Z'), CALENDAR)
        expect(q?.last).toBe(17.12)
        expect(q?.change).toBeCloseTo(17.12 - 16.9, 10)
    })

    it('computes the reopening change against the 9/10 close', () => {
        const q = computeQuote(LUV, at('2001-09-17T20:30:00Z'), CALENDAR) // after 9/17 close
        expect(q?.last).toBe(14.0)
        expect(q?.change).toBeCloseTo(14.0 - 17.12, 10)
    })

    it('steps yields daily with no intraday synthesis', () => {
        const inSession = computeQuote(US10Y, at('2001-09-13T15:00:00Z'), CALENDAR)
        expect(inSession?.last).toBe(4.64)
        expect(inSession?.change).toBeCloseTo(4.64 - 4.84, 10) // vs 9/10
    })

    it('keeps the 9/10 yield while the bond market is halted on 9/12', () => {
        const q = computeQuote(US10Y, at('2001-09-12T15:00:00Z'), CALENDAR)
        expect(q?.last).toBe(4.84)
    })

    it('returns null before any session has started', () => {
        expect(computeQuote(LUV, at('2001-09-01T00:00:00Z'), CALENDAR)).toBeNull()
    })

    it('falls back to the latest earlier bar when the display session has no bar', () => {
        const sparse: MarketSymbol = { ...US10Y, bars: US10Y.bars.filter((b) => b.date !== '2001-09-13') }
        const q = computeQuote(sparse, at('2001-09-13T15:00:00Z'), CALENDAR)
        expect(q?.last).toBe(4.84) // 9/10 value carried forward
    })
})
