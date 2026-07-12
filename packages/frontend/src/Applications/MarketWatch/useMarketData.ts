// One fetch per page load, shared by every MarketWatch mount (window closes /
// reopens must not refetch — the bundle is immutable historical data).

import { useEffect, useState } from 'react'

import type { MarketData } from './types'

export const MARKET_DATA_URL = 'https://files.911realtime.org/market/market-data.json'

let cached: MarketData | null = null
let inflight: Promise<MarketData> | null = null

export function useMarketData(enabled = true): { data: MarketData | null; error: string | null } {
    const [data, setData] = useState<MarketData | null>(cached)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (!enabled || cached) return
        let alive = true
        inflight ??= fetch(MARKET_DATA_URL).then((r) => {
            if (!r.ok) throw new Error(`market data load failed: ${r.status} ${r.statusText}`)
            return r.json() as Promise<MarketData>
        })
        inflight
            .then((bundle) => {
                cached = bundle
                if (alive) setData(bundle)
            })
            .catch((err: Error) => {
                inflight = null // let the next mount retry
                if (alive) setError(err.message)
            })
        return () => {
            alive = false
        }
    }, [enabled])

    return { data, error }
}

export function resetMarketDataCacheForTests(): void {
    cached = null
    inflight = null
}
