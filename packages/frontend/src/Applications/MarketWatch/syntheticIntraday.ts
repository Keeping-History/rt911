// Deterministic synthetic intraday price path pinned to a day's real OHLC.
// We only have daily bars (see packages/tools/market-data); during an open
// session the tape still has to move. Seeded by (symbol, date) so every
// client, render, and seek shows the identical price at the same minute.
// This module is the single seam to swap in real minute bars later (#185).

import type { DailyBar } from './types'

// cyrb53-style string hash → 32-bit seed
function hashSeed(key: string): number {
    let h1 = 0xdeadbeef
    let h2 = 0x41c6ce57
    for (let i = 0; i < key.length; i++) {
        const ch = key.charCodeAt(i)
        h1 = Math.imul(h1 ^ ch, 2654435761)
        h2 = Math.imul(h2 ^ ch, 1597334677)
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    return (h1 ^ h2) >>> 0
}

function mulberry32(seed: number): () => number {
    let a = seed
    return () => {
        a |= 0
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

// Brownian bridge from `from` to `to` over n steps (n+1 points, endpoints exact).
function bridge(from: number, to: number, n: number, wiggle: number, rand: () => number): number[] {
    const walk: number[] = [0]
    for (let i = 1; i <= n; i++) walk.push(walk[i - 1] + (rand() - 0.5))
    const drift = walk[n]
    const out: number[] = []
    for (let i = 0; i <= n; i++) {
        const chord = from + ((to - from) * i) / n
        out.push(chord + (walk[i] - (drift * i) / n) * wiggle)
    }
    return out
}

/**
 * Minute-resolution price path for one trading session: `minutes + 1` points,
 * `path[0] === open`, `path[minutes] === close`, max === high and min === low
 * (each touched exactly once by construction, then clamped). Close-only bars
 * (bond yields) yield a constant path.
 */
export function buildIntradayPath(symbol: string, bar: DailyBar, minutes: number): number[] {
    const { open, high, low, close } = bar
    if (open === undefined || high === undefined || low === undefined) {
        return new Array<number>(minutes + 1).fill(bar.close)
    }
    if (high === low) return new Array<number>(minutes + 1).fill(close)

    const rand = mulberry32(hashSeed(`${symbol}|${bar.date}`))
    // Two interior touch minutes, order randomized, kept apart from the ends.
    const t1 = 1 + Math.floor(rand() * (minutes / 2 - 2))
    const t2 = Math.ceil(minutes / 2) + Math.floor(rand() * (minutes / 2 - 2))
    const highFirst = rand() < 0.5
    const [hiAt, loAt] = highFirst ? [t1, t2] : [t2, t1]

    const wiggle = (high - low) / 6
    const anchors = [
        { at: 0, price: open },
        highFirst ? { at: hiAt, price: high } : { at: loAt, price: low },
        highFirst ? { at: loAt, price: low } : { at: hiAt, price: high },
        { at: minutes, price: close },
    ]
    const path: number[] = []
    for (let seg = 0; seg < anchors.length - 1; seg++) {
        const a = anchors[seg]
        const b = anchors[seg + 1]
        const points = bridge(a.price, b.price, b.at - a.at, wiggle, rand)
        // segments share their joint point — skip the duplicate start
        path.push(...(seg === 0 ? points : points.slice(1)))
    }
    return path.map((p) => Math.min(high, Math.max(low, p)))
}

/** Price at a whole session minute, clamped to [0, sessionEnd]. */
export function priceAtMinute(path: number[], minute: number): number {
    const i = Math.min(path.length - 1, Math.max(0, Math.floor(minute)))
    return path[i]
}
