// This repo's vitest setup has no RTL auto-cleanup (no globals), so unmount
// explicitly — otherwise every query sees stale trees from earlier tests.
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TickerTape } from './TickerTape'
import type { Quote } from './quoteBoard'

// The crawl must render its content regardless of overflow (a frozen tape
// still scrolls); the marquee lib is presentation only — swap it out.
vi.mock('../RadioScanner/marquee', () => ({
    default: ({ children }: { children: React.ReactNode }) => <div data-testid="marquee">{children}</div>,
}))

const quote = (symbol: string, last: number, change: number | null, pctChange: number | null): Quote => ({
    symbol,
    name: symbol,
    tags: ['airline'],
    unit: 'usd',
    last,
    change,
    pctChange,
})

describe('TickerTape', () => {
    afterEach(cleanup)

    it('renders a decliner as SYMBOL price ▼ change', () => {
        const { getByText } = render(<TickerTape quotes={[quote('AMR', 18.0, -11.7, -39.39)]} />)
        const item = getByText('AMR').closest('span[class*="tapeItem"]')
        expect(item?.textContent).toBe('AMR 18.00 ▼ 11.70')
    })

    it('renders a gainer with an up arrow', () => {
        const { getByText } = render(<TickerTape quotes={[quote('RTN', 31.5, 6.65, 26.76)]} />)
        const item = getByText('RTN').closest('span[class*="tapeItem"]')
        expect(item?.textContent).toBe('RTN 31.50 ▲ 6.65')
    })

    it('renders unchanged and unknown-change prints without an arrow', () => {
        const { getByText } = render(
            <TickerTape quotes={[quote('LUV', 17.12, 0.001, 0.005), quote('GS', 76.2, null, null)]} />,
        )
        expect(getByText('LUV').closest('span[class*="tapeItem"]')?.textContent).toBe('LUV 17.12 unch')
        expect(getByText('GS').closest('span[class*="tapeItem"]')?.textContent).toBe('GS 76.20')
    })

    it('keeps the given symbol order inside the crawl', () => {
        const { getByTestId } = render(
            <TickerTape quotes={[quote('A', 1, 1, 1), quote('B', 2, 1, 1), quote('C', 3, 1, 1)]} />,
        )
        const text = getByTestId('marquee').textContent ?? ''
        expect(text.indexOf('A')).toBeLessThan(text.indexOf('B'))
        expect(text.indexOf('B')).toBeLessThan(text.indexOf('C'))
    })
})
