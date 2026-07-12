import { describe, expect, it } from 'vitest'

import { formatQuote } from './format'
import type { Quote } from './quoteBoard'

const quote = (over: Partial<Quote>): Quote => ({
    symbol: 'LUV',
    name: 'Southwest Airlines',
    tags: ['airline'],
    unit: 'usd',
    last: 17.12,
    change: 0.22,
    pctChange: 1.3018,
    ...over,
})

describe('formatQuote', () => {
    it('formats a gainer with two decimals and an up direction', () => {
        const f = formatQuote(quote({}))
        expect(f).toEqual({
            last: '17.12',
            change: '+0.22',
            pctChange: '+1.30%',
            direction: 'up',
        })
    })

    it('formats a decliner with a minus sign and down direction', () => {
        const f = formatQuote(quote({ last: 14, change: -3.12, pctChange: -18.22429 }))
        expect(f).toEqual({
            last: '14.00',
            change: '-3.12',
            pctChange: '-18.22%',
            direction: 'down',
        })
    })

    it('treats a null change as unchanged', () => {
        const f = formatQuote(quote({ change: null, pctChange: null }))
        expect(f).toEqual({ last: '17.12', change: '—', pctChange: '—', direction: 'flat' })
    })

    it('formats yields as percent with basis-point-style change', () => {
        const f = formatQuote(quote({ unit: 'percent', last: 4.64, change: -0.2, pctChange: -4.13 }))
        expect(f.last).toBe('4.64%')
        expect(f.change).toBe('-0.20')
        expect(f.direction).toBe('down')
    })

    it('rounds a sub-cent change to flat', () => {
        const f = formatQuote(quote({ change: 0.001, pctChange: 0.005 }))
        expect(f.change).toBe('unch')
        expect(f.direction).toBe('flat')
    })
})
