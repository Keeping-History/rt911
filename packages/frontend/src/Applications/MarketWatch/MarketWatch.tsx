import {
    ClassicyApp,
    ClassicyIcons,
    ClassicyWindow,
    quitMenuItemHelper,
    registerClassicyIcons,
    useAppManager,
    useClassicyDateTime,
} from 'classicy'
import { useEffect, useMemo, useRef } from 'react'

import { virtualUtcMs } from '../../Providers/MediaStream/virtualClock'
import { trackAppToggle } from '../../openreplay'
import appIconPng from './app.png'
import { formatQuote } from './format'
import { marketState } from './marketClock'
import styles from './MarketWatch.module.scss'
import type { Quote } from './quoteBoard'
import { computeQuote } from './quoteBoard'
import { TickerTape } from './TickerTape'
import type { MarketTag } from './types'
import { useMarketData } from './useMarketData'

// This app's own icon, registered into the shared registry at
// ClassicyIcons.applications.marketWatch.app. registerClassicyIcons assigns
// shallowly, so the existing applications namespace is spread in to keep
// classicy's bundled app icons (and other apps' registrations) intact.
const ICONS = registerClassicyIcons({
    applications: {
        ...ClassicyIcons.applications,
        marketWatch: { app: appIconPng },
    },
})

const TILE_SYMBOLS = ['DJIA', 'SPX', 'COMP', 'US10Y']

const GROUPS: Array<{ tag: MarketTag; label: string }> = [
    { tag: 'dow30', label: 'Dow Industrials' },
    { tag: 'airline', label: 'Airlines' },
    { tag: 'insurer', label: 'Insurance' },
    { tag: 'broker', label: 'Brokerage' },
    { tag: 'defense', label: 'Defense' },
    { tag: 'travel', label: 'Travel & Leisure' },
]

const BANNER_TEXT = { open: 'MARKET OPEN', halted: 'TRADING HALTED', closed: 'MARKET CLOSED' } as const

const QuoteRow = ({ quote }: { quote: Quote }) => {
    const f = formatQuote(quote)
    return (
        <div className={styles.row}>
            <span className={styles.rowSymbol}>{quote.symbol}</span>
            <span className={styles.rowName}>{quote.name}</span>
            <span className={styles.rowNum}>{f.last}</span>
            <span className={`${styles.rowNum} ${styles[f.direction]}`}>{f.change}</span>
            <span className={`${styles.rowNum} ${styles[f.direction]}`}>{f.pctChange}</span>
        </div>
    )
}

export const MarketWatch = () => {
    const appId = 'MarketWatch.app'
    const appName = 'MarketWatch'
    const appIcon = ICONS.applications.marketWatch.app

    const isOpen = useAppManager((state) => state.System.Manager.Applications.apps[appId]?.open ?? false)
    const prevIsOpenRef = useRef<boolean | undefined>(undefined)
    useEffect(() => {
        if (prevIsOpenRef.current === undefined) {
            prevIsOpenRef.current = isOpen
            return
        }
        if (prevIsOpenRef.current === isOpen) return
        prevIsOpenRef.current = isOpen
        trackAppToggle(appId, isOpen ? 'open' : 'close')
    }, [isOpen])

    const { data, error } = useMarketData(isOpen)

    // Read-only clock (only TimeMachine mutates it); virtualUtcMs strips the
    // display tz back off. Quotes update on whole virtual minutes — the
    // era-authentic "delayed quote" cadence — while the tape scrolls on its own.
    const { localDate, tzOffset } = useClassicyDateTime({ tick: true })
    const nowMs = virtualUtcMs(localDate, tzOffset)
    const minuteMs = Math.floor(nowMs / 60_000) * 60_000

    const quotes = useMemo(() => {
        if (!data) return new Map<string, Quote>()
        const out = new Map<string, Quote>()
        for (const sym of data.symbols) {
            const q = computeQuote(sym, minuteMs, data.calendar)
            if (q) out.set(sym.symbol, q)
        }
        return out
    }, [data, minuteMs])

    const equity = data ? marketState(minuteMs, data.calendar.equity) : null

    const tiles = TILE_SYMBOLS.map((s) => quotes.get(s)).filter((q): q is Quote => !!q)
    const boardQuotes = [...quotes.values()].filter((q) => !q.tags.includes('index') && !q.tags.includes('bond'))
    const tapeQuotes = [...tiles, ...boardQuotes]

    const appMenu = [
        {
            id: 'file',
            title: 'File',
            menuChildren: [quitMenuItemHelper(appId, appName, appIcon)],
        },
    ]

    return (
        <ClassicyApp id={appId} name={appName} icon={appIcon} defaultWindow="marketwatch-board">
            <ClassicyWindow
                id="marketwatch-board"
                title="MarketWatch"
                appId={appId}
                icon={appIcon}
                initialSize={['55%', '70%']}
                initialPosition={['center', 'center']}
                appMenu={appMenu}
                scrollable={false}
                resizable
                growable
            >
                <div className={styles.content}>
                    {!data && !error && <p className={styles.loading}>Loading market data…</p>}
                    {error && <p className={styles.loading}>Market data unavailable: {error}</p>}
                    {data && equity && (
                        <>
                            <div className={`${styles.banner} ${styles[`banner_${equity.state}`]}`}>
                                <span className={styles.bannerState}>{BANNER_TEXT[equity.state]}</span>
                                {equity.state === 'halted' && (
                                    <span className={styles.bannerReason}>{equity.closure.reason}</span>
                                )}
                            </div>
                            <div className={styles.tiles}>
                                {tiles.map((q) => {
                                    const f = formatQuote(q)
                                    return (
                                        <div key={q.symbol} className={styles.tile}>
                                            <span className={styles.tileName}>{q.name}</span>
                                            <span className={styles.tileValue}>{f.last}</span>
                                            <span className={`${styles.tileChange} ${styles[f.direction]}`}>
                                                {f.change} ({f.pctChange})
                                            </span>
                                        </div>
                                    )
                                })}
                            </div>
                            <div className={styles.board}>
                                {GROUPS.map(({ tag, label }) => {
                                    const group = boardQuotes.filter((q) => q.tags.includes(tag))
                                    if (group.length === 0) return null
                                    return (
                                        <div key={tag} className={styles.group}>
                                            <div className={styles.groupHeader}>{label}</div>
                                            {group.map((q) => (
                                                <QuoteRow key={q.symbol} quote={q} />
                                            ))}
                                        </div>
                                    )
                                })}
                            </div>
                            <TickerTape quotes={tapeQuotes} />
                        </>
                    )}
                </div>
            </ClassicyWindow>
        </ClassicyApp>
    )
}
