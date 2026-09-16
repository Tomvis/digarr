// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Adaptive MusicBrainz rate governance.
//
// digarr shares one WAN IP with Lidarr, beets and Music Assistant. The old
// fixed gate (`interval: 1000, intervalCap: 1` => 3,600 req/hr) provisioned
// digarr at several times the whole household's MusicBrainz allowance, so it
// always won the race and starved the *arr stack: x-ratelimit-remaining fell
// 861 -> 33 within minutes and MB started 503-ing everyone behind that IP.
//
// MusicBrainz reports its live budget on every response (x-ratelimit-limit /
// -remaining / -reset), so the client can yield when the binding bucket is
// running low instead of guessing. These tests pin the DECISIONS -- the tier
// and the hold in milliseconds -- not call counts. The r11 zero-backoff bug
// shipped because a test asserted toHaveBeenCalledTimes(2) and never looked at
// the delay.
// ---------------------------------------------------------------------------

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Transparent p-queue: the base rate gate lives in PQueue's interval, so
// neutralising it here makes every measured gap pure adaptive hold.
vi.mock('p-queue', () => {
  const MockPQueue = vi.fn().mockImplementation(function (this: {
    add: (fn: () => unknown) => unknown
  }) {
    this.add = (fn: () => unknown) => fn()
  })
  return { default: MockPQueue }
})

// A realistic wall clock, so an epoch-seconds x-ratelimit-reset is
// unambiguously an epoch and not a small delta.
const T0 = 1_789_563_000_000

type BudgetHeaders = {
  limit?: string
  remaining?: string
  reset?: string
  zone?: string
}

function budgetHeaders(b: BudgetHeaders): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (b.limit !== undefined) h['x-ratelimit-limit'] = b.limit
  if (b.remaining !== undefined) h['x-ratelimit-remaining'] = b.remaining
  if (b.reset !== undefined) h['x-ratelimit-reset'] = b.reset
  if (b.zone !== undefined) h['x-ratelimit-zone'] = b.zone
  return h
}

/** A 200 carrying a live MB budget, with `reset` expressed as epoch seconds. */
function okWithBudget(limit: number, remaining: number, resetInSeconds: number): Response {
  return new Response(JSON.stringify({ artists: [] }), {
    status: 200,
    headers: budgetHeaders({
      limit: String(limit),
      remaining: String(remaining),
      reset: String(Math.floor(Date.now() / 1000) + resetInSeconds),
    }),
  })
}

function rateLimited(): Response {
  return new Response('', { status: 503, headers: { 'retry-after': '1' } })
}

async function freshModule() {
  // Fresh module load per test: the budget snapshot, the breaker and the
  // rate-limit cooldown are all module state shared by every client.
  vi.resetModules()
  return await import('@/core/clients/musicbrainz')
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  mockFetch.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const key of [
    'MUSICBRAINZ_MAX_RPH',
    'MUSICBRAINZ_MIN_INTERVAL_MS',
    'MUSICBRAINZ_RESERVE_RATIO',
    'MUSICBRAINZ_FLOOR_RATIO',
    'MUSICBRAINZ_BREAKER_THRESHOLD',
    'MUSICBRAINZ_BREAKER_COOLDOWN_MS',
  ]) {
    delete process.env[key]
  }
})

// ---------------------------------------------------------------------------
// Configuration: the conservative default is the floor of protection that
// applies when MB sends no headers at all.
// ---------------------------------------------------------------------------
describe('MusicBrainz rate configuration', () => {
  it('defaults to a modest fraction of the household budget, not 1 req/s', async () => {
    const { mbRateConfig } = await freshModule()
    // 360 req/hr = one request every 10s. The old gate was 3,600/hr.
    expect(mbRateConfig.maxRph).toBe(360)
    expect(mbRateConfig.baseIntervalMs).toBe(10_000)
    expect(mbRateConfig.reserveRatio).toBe(0.4)
    expect(mbRateConfig.floorRatio).toBe(0.1)
    expect(mbRateConfig.breakerThreshold).toBe(5)
    expect(mbRateConfig.breakerCooldownMs).toBe(600_000)
  })

  it('derives the base interval from MUSICBRAINZ_MAX_RPH', async () => {
    process.env.MUSICBRAINZ_MAX_RPH = '120'
    const { mbRateConfig } = await freshModule()
    expect(mbRateConfig.baseIntervalMs).toBe(30_000)
  })

  it('lets MUSICBRAINZ_MIN_INTERVAL_MS override the derived interval', async () => {
    process.env.MUSICBRAINZ_MAX_RPH = '120'
    process.env.MUSICBRAINZ_MIN_INTERVAL_MS = '2500'
    const { mbRateConfig } = await freshModule()
    expect(mbRateConfig.baseIntervalMs).toBe(2500)
  })

  it('ignores a nonsensical env value rather than disabling the gate', async () => {
    process.env.MUSICBRAINZ_MAX_RPH = '0'
    const { mbRateConfig } = await freshModule()
    expect(mbRateConfig.baseIntervalMs).toBe(10_000)
  })
})

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------
describe('parseRateLimitHeaders', () => {
  it('parses a full MusicBrainz header set with an epoch-seconds reset', async () => {
    const { parseRateLimitHeaders } = await freshModule()
    const headers = new Headers(
      budgetHeaders({
        limit: '1200',
        remaining: '861',
        reset: String(T0 / 1000 + 30),
        zone: 'global',
      }),
    )
    expect(parseRateLimitHeaders(headers, T0)).toEqual({
      limit: 1200,
      remaining: 861,
      resetAtMs: T0 + 30_000,
      zone: 'global',
      observedAtMs: T0,
    })
  })

  it('treats a small reset value as a delta in seconds', async () => {
    const { parseRateLimitHeaders } = await freshModule()
    const headers = new Headers(budgetHeaders({ limit: '400', remaining: '200', reset: '45' }))
    expect(parseRateLimitHeaders(headers, T0)?.resetAtMs).toBe(T0 + 45_000)
  })

  it('returns null when the headers are absent entirely', async () => {
    const { parseRateLimitHeaders } = await freshModule()
    expect(parseRateLimitHeaders(new Headers(), T0)).toBeNull()
  })

  it('returns null when only one of limit/remaining is present', async () => {
    const { parseRateLimitHeaders } = await freshModule()
    expect(parseRateLimitHeaders(new Headers(budgetHeaders({ limit: '400' })), T0)).toBeNull()
    expect(parseRateLimitHeaders(new Headers(budgetHeaders({ remaining: '4' })), T0)).toBeNull()
  })

  it('returns null for malformed or non-positive limits', async () => {
    const { parseRateLimitHeaders } = await freshModule()
    const malformed = new Headers(budgetHeaders({ limit: 'abc', remaining: '10' }))
    expect(parseRateLimitHeaders(malformed, T0)).toBeNull()
    const zero = new Headers(budgetHeaders({ limit: '0', remaining: '0' }))
    expect(parseRateLimitHeaders(zero, T0)).toBeNull()
  })

  it('clamps a negative remaining to zero and tolerates a missing reset', async () => {
    const { parseRateLimitHeaders } = await freshModule()
    const headers = new Headers(budgetHeaders({ limit: '400', remaining: '-5' }))
    const snapshot = parseRateLimitHeaders(headers, T0)
    expect(snapshot?.remaining).toBe(0)
    // No reset header: the reset instant is unknown, never NaN.
    expect(snapshot?.resetAtMs).toBe(T0)
    expect(snapshot?.zone).toBeNull()
  })

  it('ignores a malformed reset instead of producing NaN', async () => {
    const { parseRateLimitHeaders } = await freshModule()
    const headers = new Headers(
      budgetHeaders({ limit: '400', remaining: '100', reset: 'not-a-number' }),
    )
    expect(parseRateLimitHeaders(headers, T0)?.resetAtMs).toBe(T0)
  })
})

// ---------------------------------------------------------------------------
// The adaptive tiers. Pure function, exact milliseconds.
// ---------------------------------------------------------------------------
describe('reserveRatio=0 disables the adaptive tier', () => {
  // Regression guard for a real operator-facing failure (2026-09-16). The
  // reserve ratio was set to "0" in compose to switch adaptive throttling off;
  // `ratioOr` demanded `value > 0`, so the 0 was treated as ABSENT and the 0.4
  // default silently applied. `docker inspect` showed the variable set and the
  // logs showed the tier still holding, with nothing connecting the two.
  // Setting a knob to a valid in-range value must never be indistinguishable
  // from not setting it at all.
  const disabled = {
    maxRph: 1200,
    baseIntervalMs: 3_000,
    reserveRatio: 0,
    floorRatio: 0,
    breakerThreshold: 5,
    breakerCooldownMs: 600_000,
  }

  function snap(remaining: number, limit = 1200, resetInMs = 30_000) {
    return {
      limit,
      remaining,
      resetAtMs: T0 + resetInMs,
      zone: null,
      observedAtMs: T0,
    }
  }

  it('accepts 0 as a real value instead of falling back to the default', async () => {
    const { ratioOr } = await freshModule()
    expect(ratioOr(0, 0.4)).toBe(0)
    expect(ratioOr(0.25, 0.4)).toBe(0.25)
    // Genuinely invalid input must still fall back.
    expect(ratioOr(undefined, 0.4)).toBe(0.4)
    expect(ratioOr(-0.1, 0.4)).toBe(0.4)
    expect(ratioOr(1.5, 0.4)).toBe(0.4)
    expect(ratioOr(Number.NaN, 0.4)).toBe(0.4)
  })

  it('returns a zero hold at every budget level that would otherwise throttle', async () => {
    const { throttleDecision } = await freshModule()
    // 30% would be low tier and 2% would be floor tier under the default config.
    for (const remaining of [1200, 600, 480, 360, 120, 24, 1, 0]) {
      const d = throttleDecision(snap(remaining), T0, disabled)
      expect(d.tier, `remaining=${remaining}`).toBe('normal')
      expect(d.holdMs, `remaining=${remaining}`).toBe(0)
    }
  })

  it('does not fall into the floor tier on a NEGATIVE remaining', async () => {
    // Why this short-circuits rather than relying on `fraction >= 0`:
    // MusicBrainz does emit a negative remaining, and that arithmetic would
    // skip 'normal' and hold for up to a minute -- precisely the behaviour the
    // operator switched off.
    const { throttleDecision } = await freshModule()
    const d = throttleDecision(snap(-5), T0, disabled)
    expect(d.tier).toBe('normal')
    expect(d.holdMs).toBe(0)
  })

  it('still throttles when the reserve ratio is left at its default', async () => {
    // Guards the inverse: the disable must not leak into normal operation.
    // Note 120/1200 is exactly 10% and `fraction >= floorRatio` is inclusive,
    // so that boundary is the LOW tier -- 24 (2%) is unambiguously below it.
    const { throttleDecision } = await freshModule()
    const enabled = { ...disabled, reserveRatio: 0.4, floorRatio: 0.1 }

    const low = throttleDecision(snap(360), T0, enabled)
    expect(low.tier).toBe('low')
    expect(low.holdMs).toBeGreaterThan(0)

    const floor = throttleDecision(snap(24), T0, enabled)
    expect(floor.tier).toBe('floor')
    expect(floor.holdMs).toBeGreaterThan(0)
  })
})

describe('throttleDecision', () => {
  const config = {
    maxRph: 360,
    baseIntervalMs: 10_000,
    reserveRatio: 0.4,
    floorRatio: 0.1,
    breakerThreshold: 5,
    breakerCooldownMs: 600_000,
  }
  // The deepest low-tier hold: 3x base on top of the base interval, i.e. a 4x
  // slowdown to 90 req/hr.
  const MAX_LOW_HOLD = 30_000

  function snapshot(remaining: number, limit = 1000, resetInMs = 30_000) {
    return {
      limit,
      remaining,
      resetAtMs: T0 + resetInMs,
      zone: null,
      observedAtMs: T0,
    }
  }

  it('is a no-op when nothing has been observed yet', async () => {
    const { throttleDecision } = await freshModule()
    const d = throttleDecision(null, T0, config)
    expect(d.tier).toBe('unknown')
    expect(d.holdMs).toBe(0)
  })

  it('falls back to no-op when the last observation is stale', async () => {
    const { throttleDecision } = await freshModule()
    // 5 minutes is the staleness horizon; a 10-minute-old floor reading must
    // not pin traffic to the floor forever.
    const d = throttleDecision(snapshot(5), T0 + 600_000, config)
    expect(d.tier).toBe('unknown')
    expect(d.holdMs).toBe(0)
  })

  it('runs at full speed above the reserve', async () => {
    const { throttleDecision } = await freshModule()
    expect(throttleDecision(snapshot(900), T0, config)).toMatchObject({
      tier: 'normal',
      holdMs: 0,
    })
  })

  it('treats exactly the reserve ratio as still normal', async () => {
    const { throttleDecision } = await freshModule()
    expect(throttleDecision(snapshot(400), T0, config)).toMatchObject({
      tier: 'normal',
      holdMs: 0,
    })
  })

  it('ramps the hold in proportion to how deep into the reserve it is', async () => {
    const { throttleDecision } = await freshModule()
    // Just inside the reserve: a small hold, not a cliff.
    const shallow = throttleDecision(snapshot(399), T0, config)
    expect(shallow.tier).toBe('low')
    expect(shallow.holdMs).toBe(100)

    // Halfway between the 40% reserve and the 10% floor (= 25% remaining):
    // half the maximum low-tier hold.
    const middle = throttleDecision(snapshot(250), T0, config)
    expect(middle.tier).toBe('low')
    expect(middle.holdMs).toBe(MAX_LOW_HOLD / 2)

    // At the floor boundary: the full low-tier hold (4x slowdown).
    const deep = throttleDecision(snapshot(100), T0, config)
    expect(deep.tier).toBe('low')
    expect(deep.holdMs).toBe(MAX_LOW_HOLD)

    // Monotonic: never faster as the budget drops.
    expect(shallow.holdMs).toBeLessThan(middle.holdMs)
    expect(middle.holdMs).toBeLessThan(deep.holdMs)
  })

  it('holds until the window resets once below the hard floor', async () => {
    const { throttleDecision } = await freshModule()
    const d = throttleDecision(snapshot(20, 1000, 45_000), T0, config)
    expect(d.tier).toBe('floor')
    expect(d.holdMs).toBe(45_000)
  })

  it('never drops below the deepest low-tier hold at the floor, however near the reset', async () => {
    const { throttleDecision } = await freshModule()
    // MB's reset is often only a second or two away; yielding for 1s while
    // sitting at 2% of the budget would not be yielding at all.
    const d = throttleDecision(snapshot(20, 1000, 1_000), T0, config)
    expect(d.tier).toBe('floor')
    expect(d.holdMs).toBe(MAX_LOW_HOLD)
  })

  it('caps a distant reset so one bad header cannot wedge the client', async () => {
    const { throttleDecision } = await freshModule()
    const d = throttleDecision(snapshot(0, 1000, 3_600_000), T0, config)
    expect(d.tier).toBe('floor')
    expect(d.holdMs).toBe(60_000)
  })

  it('handles a reset that has already passed', async () => {
    const { throttleDecision } = await freshModule()
    const d = throttleDecision(snapshot(5, 1000, -5_000), T0, config)
    expect(d.tier).toBe('floor')
    expect(d.holdMs).toBe(MAX_LOW_HOLD)
  })
})

// ---------------------------------------------------------------------------
// The tiers, applied to real requests.
// ---------------------------------------------------------------------------
describe('adaptive throttling of live requests', () => {
  it('adds no hold while the budget is healthy', async () => {
    const { createMusicBrainzClient } = await freshModule()
    const at: number[] = []
    mockFetch.mockImplementation(async () => {
      at.push(Date.now())
      return okWithBudget(1000, 900, 30)
    })

    const client = createMusicBrainzClient()
    await client.searchArtist('one')
    await client.searchArtist('two')

    expect(at).toEqual([T0, T0])
  })

  it('slows sharply once the budget falls into the reserve', async () => {
    const { createMusicBrainzClient } = await freshModule()
    const at: number[] = []
    mockFetch.mockImplementation(async () => {
      at.push(Date.now())
      // 100/1000 = 10%: the bottom of the reserve band.
      return okWithBudget(1000, 100, 30)
    })

    const client = createMusicBrainzClient()
    await client.searchArtist('one')
    const second = client.searchArtist('two')
    await vi.advanceTimersByTimeAsync(60_000)
    await second

    expect(at).toHaveLength(2)
    expect((at[1] ?? 0) - (at[0] ?? 0)).toBe(30_000)
  })

  it('holds the next request until the reset once below the floor', async () => {
    const { createMusicBrainzClient } = await freshModule()
    const at: number[] = []
    mockFetch.mockImplementation(async () => {
      at.push(Date.now())
      return okWithBudget(1200, 33, 45)
    })

    const client = createMusicBrainzClient()
    await client.searchArtist('one')
    const second = client.searchArtist('two')
    await vi.advanceTimersByTimeAsync(120_000)
    await second

    expect(at).toHaveLength(2)
    expect((at[1] ?? 0) - (at[0] ?? 0)).toBe(45_000)
  })

  it('recovers full speed as soon as MB reports the budget refilled', async () => {
    const { createMusicBrainzClient } = await freshModule()
    const at: number[] = []
    let call = 0
    mockFetch.mockImplementation(async () => {
      at.push(Date.now())
      call += 1
      // First response: depleted. Second: refilled (the window reset).
      return call === 1 ? okWithBudget(1200, 33, 45) : okWithBudget(1200, 1100, 60)
    })

    const client = createMusicBrainzClient()
    await client.searchArtist('one')
    const second = client.searchArtist('two')
    await vi.advanceTimersByTimeAsync(120_000)
    await second

    // Third request sees the refilled budget and is not held at all: it fires
    // at the current instant, with no timer advance needed.
    const issuedAt = Date.now()
    await client.searchArtist('three')

    expect(at).toHaveLength(3)
    expect((at[1] ?? 0) - (at[0] ?? 0)).toBe(45_000)
    expect(at[2]).toBe(issuedAt)
  })

  it('reads the budget from a rate-limited response too, not just a 200', async () => {
    const { createMusicBrainzClient, musicBrainzRateLimitSnapshot } = await freshModule()
    mockFetch.mockResolvedValue(
      new Response('', {
        status: 503,
        headers: budgetHeaders({
          limit: '1200',
          remaining: '3',
          reset: String(T0 / 1000 + 20),
        }),
      }),
    )

    const client = createMusicBrainzClient()
    const failing = client.searchArtist('x')
    const assertion = expect(failing).rejects.toThrow()
    await vi.runAllTimersAsync()
    await assertion

    expect(musicBrainzRateLimitSnapshot()).toMatchObject({ limit: 1200, remaining: 3 })
  })
})

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------
describe('MusicBrainz circuit breaker', () => {
  it('arms after 5 consecutive rate-limited responses and then refuses without fetching', async () => {
    const { createMusicBrainzClient } = await freshModule()
    mockFetch.mockImplementation(async () => rateLimited())
    const client = createMusicBrainzClient()

    // Request 1: 1 attempt + 3 retries, all 503 => 4 consecutive rate limits.
    const first = client.searchArtist('one')
    const firstAssertion = expect(first).rejects.toThrow(/MusicBrainz HTTP 503/)
    await vi.runAllTimersAsync()
    await firstAssertion
    expect(mockFetch).toHaveBeenCalledTimes(4)

    // Request 2: its first attempt is the 5th consecutive rate limit, which
    // arms the breaker. It must abandon its remaining retries immediately
    // rather than grinding through them.
    const second = client.searchArtist('two')
    const secondAssertion = expect(second).rejects.toThrow(/circuit breaker/i)
    await vi.runAllTimersAsync()
    await secondAssertion
    expect(mockFetch).toHaveBeenCalledTimes(5)

    // Request 3: refused before it ever reaches the network.
    const third = client.searchArtist('three')
    const thirdAssertion = expect(third).rejects.toThrow(/circuit breaker/i)
    await vi.runAllTimersAsync()
    await thirdAssertion
    expect(mockFetch).toHaveBeenCalledTimes(5)
  })

  it('reports how long the cooldown has left', async () => {
    const { createMusicBrainzClient, musicBrainzDeferralReason } = await freshModule()
    mockFetch.mockImplementation(async () => rateLimited())
    const client = createMusicBrainzClient()

    const first = client.searchArtist('one')
    const firstAssertion = expect(first).rejects.toThrow()
    await vi.runAllTimersAsync()
    await firstAssertion
    const second = client.searchArtist('two')
    const secondAssertion = expect(second).rejects.toThrow(/circuit breaker/i)
    await vi.runAllTimersAsync()
    await secondAssertion

    // The breaker cooldown is minutes, not seconds -- that is the whole point.
    const reason = musicBrainzDeferralReason()
    expect(reason).toMatch(/circuit breaker/i)
    expect(reason).toMatch(/\b(9|10)m\b/)
  })

  it('a success resets the consecutive counter, so intermittent 503s never arm it', async () => {
    const { createMusicBrainzClient } = await freshModule()
    let call = 0
    mockFetch.mockImplementation(async () => {
      call += 1
      // 4 x 503 (request 1), then a success, then 4 x 503 (request 3).
      if (call === 5) return okWithBudget(1000, 900, 30)
      return rateLimited()
    })
    const client = createMusicBrainzClient()

    const first = client.searchArtist('one')
    const firstAssertion = expect(first).rejects.toThrow(/MusicBrainz HTTP 503/)
    await vi.runAllTimersAsync()
    await firstAssertion

    await vi.advanceTimersByTimeAsync(60_000)
    await client.searchArtist('two') // succeeds, resets the counter to 0

    const third = client.searchArtist('three')
    // Still the plain HTTP error, NOT the breaker: only 4 in a row this time.
    const thirdAssertion = expect(third).rejects.toThrow(/MusicBrainz HTTP 503/)
    await vi.runAllTimersAsync()
    await thirdAssertion

    expect(mockFetch).toHaveBeenCalledTimes(9)
  })

  it('releases after the cooldown elapses and lets traffic through again', async () => {
    const { createMusicBrainzClient, mbRateConfig, musicBrainzDeferralReason } = await freshModule()
    mockFetch.mockImplementation(async () => rateLimited())
    const client = createMusicBrainzClient()

    const first = client.searchArtist('one')
    const firstAssertion = expect(first).rejects.toThrow()
    await vi.runAllTimersAsync()
    await firstAssertion
    const second = client.searchArtist('two')
    const secondAssertion = expect(second).rejects.toThrow(/circuit breaker/i)
    await vi.runAllTimersAsync()
    await secondAssertion

    const fetchesWhileArmed = mockFetch.mock.calls.length
    expect(musicBrainzDeferralReason()).toMatch(/circuit breaker/i)

    // Wait the cooldown out.
    await vi.advanceTimersByTimeAsync(mbRateConfig.breakerCooldownMs + 1000)
    expect(musicBrainzDeferralReason()).toBeNull()

    mockFetch.mockImplementation(async () => okWithBudget(1000, 900, 30))
    await expect(client.searchArtist('after')).resolves.toBeDefined()
    expect(mockFetch.mock.calls.length).toBe(fetchesWhileArmed + 1)
  })

  it('honours a lowered MUSICBRAINZ_BREAKER_THRESHOLD', async () => {
    process.env.MUSICBRAINZ_BREAKER_THRESHOLD = '2'
    const { createMusicBrainzClient } = await freshModule()
    mockFetch.mockImplementation(async () => rateLimited())
    const client = createMusicBrainzClient()

    const first = client.searchArtist('one')
    const assertion = expect(first).rejects.toThrow(/circuit breaker/i)
    await vi.runAllTimersAsync()
    await assertion
    // Attempt 1 and attempt 2 trip it; the remaining retries are abandoned.
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('keeps the r11 backoff intact: no retry is ever scheduled at 0ms', async () => {
    const { createMusicBrainzClient } = await freshModule()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const at: number[] = []
    mockFetch.mockImplementation(async () => {
      at.push(Date.now())
      // Retry-After: 0 is what MB's gateway actually sends when the window
      // resets in under a second. Taking it literally is the r11 defect.
      return new Response('', { status: 503, headers: { 'retry-after': '0' } })
    })

    const client = createMusicBrainzClient()
    const p = client.searchArtist('rate-limited')
    const assertion = expect(p).rejects.toThrow()
    await vi.runAllTimersAsync()
    await assertion

    for (let i = 1; i < at.length; i += 1) {
      expect((at[i] ?? 0) - (at[i - 1] ?? 0)).toBeGreaterThanOrEqual(1000)
    }
    for (const call of warn.mock.calls) {
      expect(String(call[0])).not.toMatch(/retrying in 0ms/)
    }
  })
})

// ---------------------------------------------------------------------------
// The signal the schedulers consume.
// ---------------------------------------------------------------------------
describe('musicBrainzDeferralReason', () => {
  it('is null when nothing has been observed', async () => {
    const { musicBrainzDeferralReason } = await freshModule()
    expect(musicBrainzDeferralReason()).toBeNull()
  })

  it('is null while the budget is healthy', async () => {
    const { createMusicBrainzClient, musicBrainzDeferralReason } = await freshModule()
    mockFetch.mockImplementation(async () => okWithBudget(1000, 900, 30))
    await createMusicBrainzClient().searchArtist('x')
    expect(musicBrainzDeferralReason()).toBeNull()
  })

  it('reports a depleted budget, with the numbers, once below the floor', async () => {
    const { createMusicBrainzClient, musicBrainzDeferralReason } = await freshModule()
    mockFetch.mockImplementation(async () => okWithBudget(1200, 33, 45))
    await createMusicBrainzClient().searchArtist('x')

    const reason = musicBrainzDeferralReason()
    expect(reason).toMatch(/budget/i)
    expect(reason).toContain('33/1200')
  })

  it('stops reporting a depleted budget once the observation goes stale', async () => {
    const { createMusicBrainzClient, musicBrainzDeferralReason } = await freshModule()
    mockFetch.mockImplementation(async () => okWithBudget(1200, 33, 45))
    await createMusicBrainzClient().searchArtist('x')
    expect(musicBrainzDeferralReason()).not.toBeNull()

    await vi.advanceTimersByTimeAsync(600_000)
    expect(musicBrainzDeferralReason()).toBeNull()
  })
})
