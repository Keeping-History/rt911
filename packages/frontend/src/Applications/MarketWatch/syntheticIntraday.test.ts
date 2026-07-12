import { describe, expect, it } from 'vitest'

import { buildIntradayPath, priceAtMinute } from './syntheticIntraday'
import type { DailyBar } from './types'

const AMR_0917: DailyBar = { date: '2001-09-17', open: 21.5, high: 21.5, low: 17.9, close: 18.0 }
const LUV_0910: DailyBar = { date: '2001-09-10', open: 17.0, high: 17.5, low: 16.8, close: 17.12 }
const MINUTES = 390 // 9:30–16:00

describe('buildIntradayPath', () => {
    it('pins the first point to the open and the last to the close', () => {
        const path = buildIntradayPath('AMR', AMR_0917, MINUTES)
        expect(path).toHaveLength(MINUTES + 1)
        expect(path[0]).toBe(21.5)
        expect(path[MINUTES]).toBe(18.0)
    })

    it('touches the high and the low exactly and never exceeds either', () => {
        const path = buildIntradayPath('LUV', LUV_0910, MINUTES)
        expect(Math.max(...path)).toBe(17.5)
        expect(Math.min(...path)).toBe(16.8)
    })

    it('is deterministic: same (symbol, date) → identical path on every call', () => {
        const a = buildIntradayPath('LUV', LUV_0910, MINUTES)
        const b = buildIntradayPath('LUV', LUV_0910, MINUTES)
        expect(a).toEqual(b)
    })

    it('differs between symbols and between dates', () => {
        const luv = buildIntradayPath('LUV', LUV_0910, MINUTES)
        const amr = buildIntradayPath('AMR', { ...LUV_0910 }, MINUTES)
        const otherDay = buildIntradayPath('LUV', { ...LUV_0910, date: '2001-09-18' }, MINUTES)
        expect(amr).not.toEqual(luv)
        expect(otherDay).not.toEqual(luv)
    })

    it('handles a flat bar (open=high=low=close) with a constant path', () => {
        const flat: DailyBar = { date: '2001-09-10', open: 5, high: 5, low: 5, close: 5 }
        const path = buildIntradayPath('X', flat, MINUTES)
        expect(path.every((p) => p === 5)).toBe(true)
    })

    it('falls back to a constant close-only path when OHLC is absent (yields)', () => {
        const closeOnly: DailyBar = { date: '2001-09-13', close: 4.64 }
        const path = buildIntradayPath('US10Y', closeOnly, MINUTES)
        expect(path.every((p) => p === 4.64)).toBe(true)
    })
})

describe('priceAtMinute', () => {
    it('indexes the path by whole session minutes, clamped to the session', () => {
        const path = buildIntradayPath('LUV', LUV_0910, MINUTES)
        expect(priceAtMinute(path, 0)).toBe(path[0])
        expect(priceAtMinute(path, 42)).toBe(path[42])
        expect(priceAtMinute(path, -5)).toBe(path[0])
        expect(priceAtMinute(path, 9999)).toBe(path[MINUTES])
    })
})
