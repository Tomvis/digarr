// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Retry/backoff contract for the MusicBrainz client.
//
// MusicBrainz answers a rate-limited request with HTTP 503 and a `Retry-After`
// header that its gateway floors to whole seconds -- so a window resetting in
// under a second is reported as `Retry-After: 0`. Taking that literally means
// retrying instantly, which re-trips the limiter and sustains a 503 storm
// (8,324 of them in 48h in production). These tests pin the delay itself, not
// just the attempt count.
// ---------------------------------------------------------------------------

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Transparent p-queue so the measured gaps are pure backoff, with no 1 req/s
// rate-gate interval folded in.
vi.mock('p-queue', () => {
  const MockPQueue = vi.fn().mockImplementation(function (this: {
    add: (fn: () => unknown) => unknown
  }) {
    this.add = (fn: () => unknown) => fn()
  })
  return { default: MockPQueue }
})

async function freshClient() {
  // Fresh module load per test so the shared queue and the module-level
  // rate-limit cooldown start clean under the current fake clock.
  vi.resetModules()
  const { createMusicBrainzClient } = await import('@/core/clients/musicbrainz')
  return createMusicBrainzClient()
}

function gapsBetween(timestamps: number[]): number[] {
  const gaps: number[] = []
  for (let i = 1; i < timestamps.length; i += 1) {
    gaps.push((timestamps[i] ?? 0) - (timestamps[i - 1] ?? 0))
  }
  return gaps
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  mockFetch.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('MusicBrainz retry backoff', () => {
  it('backs off with increasing, non-zero delays when MB sends Retry-After: 0', async () => {
    const attemptsAt: number[] = []
    mockFetch.mockImplementation(async () => {
      attemptsAt.push(Date.now())
      return new Response('', { status: 503, headers: { 'retry-after': '0' } })
    })

    const client = await freshClient()
    const assertion = expect(client.searchArtist('rate-limited')).rejects.toThrow(
      /MusicBrainz HTTP 503/,
    )
    await vi.runAllTimersAsync()
    await assertion

    // 1 initial attempt + 3 retries
    expect(attemptsAt).toHaveLength(4)

    const gaps = gapsBetween(attemptsAt)
    // No retry may fire sooner than MusicBrainz's published 1 req/s ceiling.
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(1000)
    }
    // ...and each successive retry must wait meaningfully longer.
    expect(gaps[1]).toBeGreaterThan(gaps[0] ?? 0)
    expect(gaps[2]).toBeGreaterThan(gaps[1] ?? 0)
    // Doubling, not creeping: attempt 3 waits at least ~4x attempt 1.
    expect(gaps[2]).toBeGreaterThanOrEqual(4000)
  })

  it('honours a Retry-After that is longer than the exponential backoff', async () => {
    const attemptsAt: number[] = []
    mockFetch.mockImplementation(async () => {
      attemptsAt.push(Date.now())
      if (attemptsAt.length === 1) {
        return new Response('', { status: 503, headers: { 'retry-after': '5' } })
      }
      return new Response(JSON.stringify({ artists: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    const client = await freshClient()
    const promise = client.searchArtist('slow-down')
    await vi.runAllTimersAsync()
    await promise

    expect(attemptsAt).toHaveLength(2)
    expect(gapsBetween(attemptsAt)[0]).toBeGreaterThanOrEqual(5000)
  })

  it('caps Retry-After so a hostile header cannot stall the client', async () => {
    const attemptsAt: number[] = []
    mockFetch.mockImplementation(async () => {
      attemptsAt.push(Date.now())
      if (attemptsAt.length === 1) {
        return new Response('', { status: 503, headers: { 'retry-after': '86400' } })
      }
      return new Response(JSON.stringify({ artists: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    const client = await freshClient()
    const promise = client.searchArtist('hostile-header')
    await vi.runAllTimersAsync()
    await promise

    // 30s cap + at most 25% jitter
    expect(gapsBetween(attemptsAt)[0]).toBeLessThanOrEqual(37_500)
  })

  it('applies proportional jitter so parallel retries desynchronise', async () => {
    const attemptsAt: number[] = []
    mockFetch.mockImplementation(async () => {
      attemptsAt.push(Date.now())
      if (attemptsAt.length === 1) return new Response('', { status: 503 })
      return new Response(JSON.stringify({ artists: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    // Worst-case jitter draw: the delay must stretch, never collapse.
    vi.spyOn(Math, 'random').mockReturnValue(1)

    const client = await freshClient()
    const promise = client.searchArtist('jittered')
    await vi.runAllTimersAsync()
    await promise

    const gap = gapsBetween(attemptsAt)[0] ?? 0
    expect(gap).toBeGreaterThan(1000)
    expect(gap).toBeLessThanOrEqual(1250)
  })

  it('holds new requests while a rate-limit cooldown from another request is active', async () => {
    const calls: Array<{ query: string; t: number }> = []
    mockFetch.mockImplementation(async (url: string) => {
      const query = new URL(url).searchParams.get('query') ?? ''
      const seen = calls.filter((c) => c.query === query).length
      calls.push({ query, t: Date.now() })
      if (query === 'first' && seen === 0) {
        return new Response('', { status: 503, headers: { 'retry-after': '0' } })
      }
      return new Response(JSON.stringify({ artists: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    const client = await freshClient()
    const first = client.searchArtist('first')
    // Let the 503 land and arm the shared cooldown before the second caller starts.
    await vi.advanceTimersByTimeAsync(0)
    const second = client.searchArtist('second')

    await vi.runAllTimersAsync()
    await Promise.all([first, second])

    const secondCall = calls.find((c) => c.query === 'second')
    expect(secondCall).toBeDefined()
    // A sibling request issued mid-cooldown must not walk straight into the
    // limiter; it waits out the shared cooldown too.
    expect(secondCall?.t).toBeGreaterThanOrEqual(1000)
  })
})
