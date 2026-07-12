// CNBC-2001-style crawl. The marquee animates continuously even when the
// prints are frozen — real crawls kept scrolling through the closure week.

import Marquee from '../RadioScanner/marquee'
import { formatQuote } from './format'
import styles from './MarketWatch.module.scss'
import type { Quote } from './quoteBoard'

const ARROWS = { up: '▲', down: '▼' } as const

export const TickerTape = ({ quotes }: { quotes: Quote[] }) => (
    <div className={styles.tape} data-testid="market-ticker-tape">
        <Marquee speed={40} gradient={false} autoFill>
            {quotes.map((q) => {
                const f = formatQuote(q)
                return (
                    <span key={q.symbol} className={`${styles.tapeItem} ${styles[f.direction]}`}>
                        <span className={styles.tapeSymbol}>{q.symbol}</span> {f.last}
                        {f.direction === 'flat'
                            ? f.change === 'unch'
                                ? ' unch'
                                : ''
                            : ` ${ARROWS[f.direction]} ${f.change.slice(1)}`}
                    </span>
                )
            })}
        </Marquee>
    </div>
)
