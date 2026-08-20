import { describe, expect, it } from 'vitest'

import { displaySessionDate, marketState } from './marketClock'
import type { MarketCalendar } from './types'

// Mirrors the generator's real Sept-2001 calendar (market_calendar.py)
const day = (d: string, open: string, close: string) => ({
    date: d,
    open: `${d}T${open}:00Z`,
    close: `${d}T${close}:00Z`,
})

const EQUITY: MarketCalendar = {
    sessions: ['2001-09-04', '2001-09-05', '2001-09-06', '2001-09-07', '2001-09-10', '2001-09-17', '2001-09-18'].map(
        (d) => day(d, '13:30', '20:00'),
    ),
    closures: [
        {
            start: '2001-09-11T12:46:00Z',
            end: '2001-09-17T13:30:00Z',
            reason: 'NYSE and Nasdaq closed following the September 11 attacks — the longest closure since 1933',
        },
    ],
}

const BOND: MarketCalendar = {
    sessions: ['2001-09-07', '2001-09-10', '2001-09-13', '2001-09-14', '2001-09-17'].map((d) =>
        day(d, '12:00', '21:00'),
    ),
    closures: [
        {
            start: '2001-09-11T12:46:00Z',
            end: '2001-09-13T12:00:00Z',
            reason: 'US bond market closed following the September 11 attacks',
        },
    ],
}

const at = (iso: string) => Date.parse(iso)

describe('marketState', () => {
    it('is closed on the weekend before 9/10', () => {
        expect(marketState(at('2001-09-09T15:00:00Z'), EQUITY).state).toBe('closed')
    })

    it('is closed one minute before the 9/10 open and open at the bell', () => {
        expect(marketState(at('2001-09-10T13:29:00Z'), EQUITY).state).toBe('closed')
        const open = marketState(at('2001-09-10T13:30:00Z'), EQUITY)
        expect(open.state).toBe('open')
        expect(open.state === 'open' && open.session.date).toBe('2001-09-10')
    })

    it('is open through the 9/10 session and closed at the 16:00 ET close', () => {
        expect(marketState(at('2001-09-10T19:59:59Z'), EQUITY).state).toBe('open')
        expect(marketState(at('2001-09-10T20:00:00Z'), EQUITY).state).toBe('closed')
    })

    it('is closed (ordinary overnight) before the first impact on 9/11', () => {
        expect(marketState(at('2001-09-11T12:00:00Z'), EQUITY).state).toBe('closed')
    })

    it('is halted from the first impact at 8:46 ET on 9/11', () => {
        const s = marketState(at('2001-09-11T12:46:00Z'), EQUITY)
        expect(s.state).toBe('halted')
        expect(s.state === 'halted' && s.closure.reason).toContain('1933')
    })

    it('stays halted across the closure week — the open never rings on 9/11', () => {
        expect(marketState(at('2001-09-11T13:30:00Z'), EQUITY).state).toBe('halted')
        expect(marketState(at('2001-09-12T16:00:00Z'), EQUITY).state).toBe('halted')
        expect(marketState(at('2001-09-14T18:00:00Z'), EQUITY).state).toBe('halted')
        expect(marketState(at('2001-09-16T23:00:00Z'), EQUITY).state).toBe('halted')
    })

    it('reopens exactly at the 9/17 bell', () => {
        expect(marketState(at('2001-09-17T13:29:59Z'), EQUITY).state).toBe('halted')
        const s = marketState(at('2001-09-17T13:30:00Z'), EQUITY)
        expect(s.state).toBe('open')
        expect(s.state === 'open' && s.session.date).toBe('2001-09-17')
    })

    it('bond market stays halted on 9/12 but reopens Thursday 9/13 at 8:00 ET', () => {
        expect(marketState(at('2001-09-12T15:00:00Z'), BOND).state).toBe('halted')
        const s = marketState(at('2001-09-13T12:00:00Z'), BOND)
        expect(s.state).toBe('open')
        expect(s.state === 'open' && s.session.date).toBe('2001-09-13')
    })

    it('bond market weekend after reopening is ordinary closed, not halted', () => {
        expect(marketState(at('2001-09-15T15:00:00Z'), BOND).state).toBe('closed')
    })
})

describe('displaySessionDate', () => {
    it('uses the in-progress session during trading', () => {
        expect(displaySessionDate(at('2001-09-10T15:00:00Z'), EQUITY)).toBe('2001-09-10')
    })

    it('uses the prior Friday over the pre-attack weekend', () => {
        expect(displaySessionDate(at('2001-09-09T15:00:00Z'), EQUITY)).toBe('2001-09-07')
    })

    it('freezes on 9/10 for the whole closure week', () => {
        expect(displaySessionDate(at('2001-09-11T14:00:00Z'), EQUITY)).toBe('2001-09-10')
        expect(displaySessionDate(at('2001-09-14T14:00:00Z'), EQUITY)).toBe('2001-09-10')
        expect(displaySessionDate(at('2001-09-17T13:29:00Z'), EQUITY)).toBe('2001-09-10')
    })

    it('flips to 9/17 at the reopening bell', () => {
        expect(displaySessionDate(at('2001-09-17T13:30:00Z'), EQUITY)).toBe('2001-09-17')
    })

    it('is null before the first session in range', () => {
        expect(displaySessionDate(at('2001-09-01T00:00:00Z'), EQUITY)).toBeNull()
    })
})
