// Mirrors packages/tools/market-data/schema/market-data.schema.json — the
// static bundle served from files.911realtime.org/market/market-data.json.

export interface MarketSession {
    date: string // YYYY-MM-DD (exchange trading day)
    open: string // ISO UTC
    close: string // ISO UTC
}

export interface MarketClosure {
    start: string // ISO UTC
    end: string // ISO UTC
    reason: string
}

export interface MarketCalendar {
    sessions: MarketSession[]
    closures: MarketClosure[]
}

export interface DailyBar {
    date: string
    open?: number
    high?: number
    low?: number
    close: number
    volume?: number
}

export type MarketTag = 'index' | 'dow30' | 'airline' | 'insurer' | 'broker' | 'defense' | 'travel' | 'bond'

export interface MarketSymbol {
    symbol: string
    name: string
    tags: MarketTag[]
    unit: 'usd' | 'percent'
    market: 'equity' | 'bond'
    source: string
    bars: DailyBar[]
}

export interface MarketData {
    version: 1
    generatedAt?: string
    range: { start: string; end: string }
    calendar: { equity: MarketCalendar; bond: MarketCalendar }
    symbols: MarketSymbol[]
}
