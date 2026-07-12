// Display formatting for quotes — CNBC-2001 conventions: decimal prices
// (fractions died in April 2001), signed change, "unch" for a flat print.

import type { Quote } from './quoteBoard'

export type Direction = 'up' | 'down' | 'flat'

export interface FormattedQuote {
    last: string
    change: string
    pctChange: string
    direction: Direction
}

const EPSILON = 0.005 // anything under half a cent prints as unchanged

export function formatQuote(q: Quote): FormattedQuote {
    const last = q.unit === 'percent' ? `${q.last.toFixed(2)}%` : q.last.toFixed(2)
    if (q.change === null || q.pctChange === null) {
        return { last, change: '—', pctChange: '—', direction: 'flat' }
    }
    if (Math.abs(q.change) < EPSILON) {
        return { last, change: 'unch', pctChange: 'unch', direction: 'flat' }
    }
    const sign = q.change > 0 ? '+' : '-'
    return {
        last,
        change: `${sign}${Math.abs(q.change).toFixed(2)}`,
        pctChange: `${sign}${Math.abs(q.pctChange).toFixed(2)}%`,
        direction: q.change > 0 ? 'up' : 'down',
    }
}
