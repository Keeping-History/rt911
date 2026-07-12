// This repo's vitest setup has no RTL auto-cleanup (no globals), so unmount
// explicitly — otherwise every query sees stale trees from earlier tests.
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildIntradayPath, priceAtMinute } from './syntheticIntraday'
import type { MarketData } from './types'
import { resetMarketDataCacheForTests } from './useMarketData'

const mockClock = vi.hoisted(() => ({ current: Date.parse('2001-09-10T15:00:00Z') }))

vi.mock('classicy', () => ({
    ClassicyApp: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    ClassicyWindow: ({ children, title }: { children: React.ReactNode; title: string }) => (
        <section aria-label={title}>{children}</section>
    ),
    ClassicyIcons: { applications: {} },
    registerClassicyIcons: <T,>(icons: T) => icons,
    quitMenuItemHelper: () => ({}),
    useAppManager: (sel: (s: unknown) => unknown) =>
        sel({
            System: {
                Manager: {
                    Applications: {
                        apps: { 'MarketWatch.app': { open: true, windows: [] } },
                    },
                },
            },
        }),
    useAppManagerDispatch: () => vi.fn(),
    useClassicyDateTime: () => ({
        localDate: new Date(mockClock.current),
        tzOffset: 0,
        paused: false,
    }),
}))

vi.mock('../../openreplay', () => ({ trackAppToggle: vi.fn() }))

vi.mock('../RadioScanner/marquee', () => ({
    default: ({ children }: { children: React.ReactNode }) => <div data-testid="marquee">{children}</div>,
}))

import { MarketWatch } from './MarketWatch'

const day = (d: string, open: string, close: string) => ({
    date: d,
    open: `${d}T${open}:00Z`,
    close: `${d}T${close}:00Z`,
})

const bar = (date: string, close: number, spread = 1) => ({
    date,
    open: close - spread / 2,
    high: close + spread,
    low: close - spread,
    close,
})

const BUNDLE: MarketData = {
    version: 1,
    range: { start: '2001-09-04', end: '2001-09-21' },
    calendar: {
        equity: {
            sessions: ['2001-09-07', '2001-09-10', '2001-09-17', '2001-09-18'].map((d) => day(d, '13:30', '20:00')),
            closures: [
                {
                    start: '2001-09-11T12:46:00Z',
                    end: '2001-09-17T13:30:00Z',
                    reason: 'NYSE and Nasdaq closed following the September 11 attacks — the longest closure since 1933',
                },
            ],
        },
        bond: {
            sessions: ['2001-09-07', '2001-09-10', '2001-09-13', '2001-09-14', '2001-09-17', '2001-09-18'].map((d) =>
                day(d, '12:00', '21:00'),
            ),
            closures: [{ start: '2001-09-11T12:46:00Z', end: '2001-09-13T12:00:00Z', reason: 'bond closed' }],
        },
    },
    symbols: [
        {
            symbol: 'DJIA',
            name: 'Dow Jones Industrials',
            tags: ['index'],
            unit: 'usd',
            market: 'equity',
            source: 'yahoo:^DJI',
            bars: [bar('2001-09-07', 9605.85), bar('2001-09-10', 9605.51), bar('2001-09-17', 8920.7)],
        },
        {
            symbol: 'LUV',
            name: 'Southwest Airlines',
            tags: ['airline'],
            unit: 'usd',
            market: 'equity',
            source: 'yahoo:LUV',
            bars: [bar('2001-09-07', 16.9), bar('2001-09-10', 17.12), bar('2001-09-17', 14.0)],
        },
        {
            symbol: 'US10Y',
            name: '10-Yr Treasury Yield',
            tags: ['bond'],
            unit: 'percent',
            market: 'bond',
            source: 'fred:DGS10',
            bars: [
                { date: '2001-09-07', close: 4.8 },
                { date: '2001-09-10', close: 4.84 },
                { date: '2001-09-13', close: 4.64 },
            ],
        },
    ],
}

describe('MarketWatch', () => {
    beforeEach(() => {
        resetMarketDataCacheForTests()
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(BUNDLE) }),
        )
    })
    afterEach(() => {
        cleanup()
        vi.unstubAllGlobals()
    })

    it('shows MARKET OPEN and a moving synthetic quote during the 9/10 session', async () => {
        mockClock.current = Date.parse('2001-09-10T15:00:00Z') // minute 90
        const { getByText, getAllByText } = render(<MarketWatch />)
        await waitFor(() => expect(getByText('MARKET OPEN')).toBeTruthy())
        const luvBar = BUNDLE.symbols[1].bars[1]
        const expected = priceAtMinute(buildIntradayPath('LUV', luvBar, 390), 90)
        expect(getAllByText(expected.toFixed(2)).length).toBeGreaterThan(0)
    })

    it('shows the halt banner with the closure reason on 9/12', async () => {
        mockClock.current = Date.parse('2001-09-12T16:00:00Z')
        const { getByText, getAllByText } = render(<MarketWatch />)
        await waitFor(() => expect(getByText('TRADING HALTED')).toBeTruthy())
        expect(getByText(/longest closure since 1933/)).toBeTruthy()
        // frozen on the 9/10 close
        expect(getAllByText('17.12').length).toBeGreaterThan(0)
    })

    it('shows MARKET CLOSED with prior-Friday prints over the weekend', async () => {
        mockClock.current = Date.parse('2001-09-09T15:00:00Z')
        const { getByText, getAllByText } = render(<MarketWatch />)
        await waitFor(() => expect(getByText('MARKET CLOSED')).toBeTruthy())
        expect(getAllByText('16.90').length).toBeGreaterThan(0)
    })

    it('renders index tiles including the 10-yr yield', async () => {
        mockClock.current = Date.parse('2001-09-12T16:00:00Z')
        const { getByText, getAllByText } = render(<MarketWatch />)
        await waitFor(() => expect(getByText('Dow Jones Industrials')).toBeTruthy())
        expect(getAllByText('9605.51').length).toBeGreaterThan(0)
        expect(getAllByText('4.84%').length).toBeGreaterThan(0)
    })

    it('groups the quote board and feeds the ticker tape', async () => {
        mockClock.current = Date.parse('2001-09-12T16:00:00Z')
        const { getByText, getByTestId, getAllByText } = render(<MarketWatch />)
        await waitFor(() => expect(getByText('Airlines')).toBeTruthy())
        expect(getByTestId('marquee')).toBeTruthy()
        expect(getAllByText('LUV').length).toBeGreaterThan(0)
    })
})
