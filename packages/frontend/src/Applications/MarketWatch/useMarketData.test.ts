import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MARKET_DATA_URL, resetMarketDataCacheForTests, useMarketData } from './useMarketData'

const BUNDLE = {
    version: 1,
    range: { start: '2001-09-04', end: '2001-09-21' },
    calendar: { equity: { sessions: [], closures: [] }, bond: { sessions: [], closures: [] } },
    symbols: [],
}

describe('useMarketData', () => {
    beforeEach(() => resetMarketDataCacheForTests())
    afterEach(() => vi.unstubAllGlobals())

    it('fetches the bundle and exposes it', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(BUNDLE) })
        vi.stubGlobal('fetch', fetchMock)
        const { result } = renderHook(() => useMarketData())
        expect(result.current.data).toBeNull()
        await waitFor(() => expect(result.current.data).toEqual(BUNDLE))
        expect(fetchMock).toHaveBeenCalledWith(MARKET_DATA_URL)
    })

    it('fetches only once across mounts (module-scope cache)', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(BUNDLE) })
        vi.stubGlobal('fetch', fetchMock)
        const first = renderHook(() => useMarketData())
        await waitFor(() => expect(first.result.current.data).toEqual(BUNDLE))
        first.unmount()
        const second = renderHook(() => useMarketData())
        expect(second.result.current.data).toEqual(BUNDLE) // synchronously, from cache
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('does not fetch while disabled, then fetches on enable', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(BUNDLE) })
        vi.stubGlobal('fetch', fetchMock)
        const { result, rerender } = renderHook(({ enabled }: { enabled: boolean }) => useMarketData(enabled), {
            initialProps: { enabled: false },
        })
        expect(fetchMock).not.toHaveBeenCalled()
        rerender({ enabled: true })
        await waitFor(() => expect(result.current.data).toEqual(BUNDLE))
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('reports an error on a failed response and allows a later retry', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable' })
            .mockResolvedValue({ ok: true, json: () => Promise.resolve(BUNDLE) })
        vi.stubGlobal('fetch', fetchMock)
        const failed = renderHook(() => useMarketData())
        await waitFor(() => expect(failed.result.current.error).toContain('503'))
        expect(failed.result.current.data).toBeNull()
        failed.unmount()
        // a fresh mount retries because the failed promise was not cached
        const retried = renderHook(() => useMarketData())
        await waitFor(() => expect(retried.result.current.data).toEqual(BUNDLE))
    })
})
