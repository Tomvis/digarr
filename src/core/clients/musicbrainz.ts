import PQueue from 'p-queue'
import { envConfig } from '@/config/env'
import { VERSION } from '@/version'

const BASE_URL = 'https://musicbrainz.org/ws/2'
const USER_AGENT = `Digarr/${VERSION} (https://github.com/iuliandita/digarr)`

export type MBArtist = {
  id: string
  name: string
  disambiguation?: string
  'life-span'?: {
    begin?: string
    end?: string
    ended?: boolean
  }
  tags?: Array<{ name: string; count: number }>
  relations?: MBRelation[]
}

/** Extract year from MB date string ("1985", "1985-03", "1985-03-15") */
export function parseYear(dateStr?: string): number | undefined {
  if (!dateStr) return undefined
  const year = Number.parseInt(dateStr.substring(0, 4), 10)
  return Number.isNaN(year) ? undefined : year
}

export type MBRelation = {
  type: string
  direction?: 'forward' | 'backward'
  url?: { resource: string }
  // Present on artist-artist relations (inc=artist-rels): the related artist.
  artist?: { id: string; name: string; disambiguation?: string }
}

export type MBSearchResult = {
  artists: Array<{
    id: string
    name: string
    disambiguation?: string
    tags?: Array<{ name: string; count: number }>
    score: number
  }>
}

export type MBReleaseGroup = {
  id: string
  title: string
  type: string
  firstReleaseDate?: string
}

export type MBRecording = {
  id: string
  title: string
  isrcs?: string[]
}

export type RecordingArtistCredit = {
  recordingMbid: string
  artistMbid: string
  artistName: string
}

type MBRecordingLookup = {
  id: string
  title: string
  'artist-credit'?: Array<{
    artist: { id: string; name: string }
  }>
}

export type StreamingUrls = {
  spotify?: string
  youtube?: string
  appleMusic?: string
  deezer?: string
  tidal?: string
  soundcloud?: string
  bandcamp?: string
}

const STREAMING_PATTERNS: Array<[RegExp, keyof StreamingUrls]> = [
  [/spotify\.com/i, 'spotify'],
  [/music\.youtube\.com/i, 'youtube'],
  [/youtube\.com/i, 'youtube'],
  [/music\.apple\.com/i, 'appleMusic'],
  [/deezer\.com/i, 'deezer'],
  [/tidal\.com/i, 'tidal'],
  [/soundcloud\.com/i, 'soundcloud'],
  [/bandcamp\.com/i, 'bandcamp'],
]

const STREAMING_TYPES = new Set(['streaming music', 'free streaming'])

const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504])
// Statuses that mean "you are over the rate limit", as opposed to "upstream
// hiccupped". MusicBrainz answers a throttled request with 503, not 429.
const RATE_LIMIT_STATUSES = new Set([429, 503])
const MAX_RETRIES = 3
const BASE_BACKOFF_MS = 1000
// MusicBrainz publishes a ceiling of 1 request/second. Nothing may retry
// sooner than that, whatever Retry-After claims.
const MIN_RETRY_DELAY_MS = 1000
const MAX_BACKOFF_MS = 30_000
const MAX_RETRY_AFTER_MS = 30_000
// Jitter as a fraction of the delay, so parallel retries desynchronise at every
// backoff step rather than only at the first (a flat ±250ms is noise next to a
// 4s wait).
const JITTER_RATIO = 0.25

/**
 * Parse a Retry-After header into milliseconds, or null when it is absent or
 * unusable.
 *
 * The value is deliberately NOT trusted as the delay: MusicBrainz's gateway
 * floors its rate-limit window to whole seconds, so a window resetting in under
 * a second is reported as `Retry-After: 0`. Callers must treat the result as a
 * lower bound combined with their own backoff (see backoffDelayMs).
 */
export function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null
  const trimmed = header.trim()
  if (trimmed === '') return null
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
  }
  // HTTP-date form
  const when = Date.parse(trimmed)
  if (Number.isFinite(when)) {
    return Math.min(Math.max(when - Date.now(), 0), MAX_RETRY_AFTER_MS)
  }
  return null
}

/**
 * Delay before retry `attempt` (0-based): exponential from BASE_BACKOFF_MS,
 * capped, never below MusicBrainz's 1 req/s floor, with proportional jitter.
 *
 * `retryAfterMs` raises the floor but can never lower it. Using it directly
 * (`retryAfter ?? backoff`) is what produced "retrying in 0ms" in production:
 * `??` only falls through on null/undefined, so a `Retry-After: 0` became a
 * zero-delay retry that re-tripped the limiter immediately.
 */
export function backoffDelayMs(attempt: number, retryAfterMs: number | null = null): number {
  const exponential = BASE_BACKOFF_MS * 2 ** attempt
  const floor = Math.max(exponential, retryAfterMs ?? 0, MIN_RETRY_DELAY_MS)
  const capped = Math.min(floor, MAX_BACKOFF_MS)
  // Whole milliseconds only: setTimeout truncates fractional delays, so a
  // fractional deadline can never be reached and a wait loop would spin.
  return Math.round(capped + capped * JITTER_RATIO * Math.random())
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Rate governance
//
// MusicBrainz rate-limits per source IP, so the budget is a HOUSEHOLD budget,
// not digarr's: Lidarr, beets and Music Assistant sit behind the same WAN
// address. The old gate (`interval: 1000, intervalCap: 1`) provisioned digarr
// at 3,600 req/hr -- several times the whole allowance -- so digarr always won
// the race, drove x-ratelimit-remaining to the floor and left the *arr stack
// getting 503s.
//
// Two mechanisms, in order of importance:
//
//  1. ADAPTIVE. MusicBrainz reports its live budget on every response
//     (x-ratelimit-limit / -remaining / -reset). Above a reserve we run at the
//     configured pace; inside the reserve we ramp the pace down in proportion
//     to how deep we are; below a hard floor we hold until the window resets.
//     This is self-correcting -- digarr gives way while the *arr stack is busy
//     and takes the slack when the household is idle -- without hard-coding
//     anyone's share.
//
//  2. A CONSERVATIVE FIXED CEILING underneath it, which is what applies when
//     the headers are missing or unusable.
//
// All of this is in-memory and deliberately so: digarr is a single Node
// process, and a cross-process token bucket would be a lot of machinery for one
// container. What a restart loses is the observed budget, the consecutive
// rate-limit count and an armed circuit breaker -- i.e. a restarted digarr
// behaves as though MusicBrainz had never answered: it runs at the fixed
// conservative pace and re-learns the budget from the first response. A
// restart therefore CLEARS an armed breaker. That is accepted: the fixed
// ceiling still applies, and the breaker re-arms within `breakerThreshold`
// responses if MusicBrainz is still refusing.
// ---------------------------------------------------------------------------

/** 360 req/hr = one request every 10s, ~30% of a 1,200/hr household budget. */
const DEFAULT_MAX_RPH = 360
const DEFAULT_RESERVE_RATIO = 0.4
const DEFAULT_FLOOR_RATIO = 0.1
const DEFAULT_BREAKER_THRESHOLD = 5
const DEFAULT_BREAKER_COOLDOWN_MS = 10 * 60_000
/** Deepest low-tier slowdown, as a multiple of the base interval. */
const LOW_TIER_MAX_MULTIPLIER = 4
/** No single request is ever held longer than this, whatever a header claims. */
const MAX_ADAPTIVE_HOLD_MS = 60_000
/** An observation older than this says nothing about the budget now. */
const SNAPSHOT_STALE_MS = 5 * 60_000

export type MbRateConfig = {
  maxRph: number
  baseIntervalMs: number
  reserveRatio: number
  floorRatio: number
  breakerThreshold: number
  breakerCooldownMs: number
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

function ratioOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback
}

function resolveMbRateConfig(): MbRateConfig {
  const maxRph = positiveOr(envConfig.musicbrainzMaxRph, DEFAULT_MAX_RPH)
  const derivedIntervalMs = Math.round(3_600_000 / maxRph)
  const reserveRatio = ratioOr(envConfig.musicbrainzReserveRatio, DEFAULT_RESERVE_RATIO)
  return {
    maxRph,
    // An explicit interval wins over the rate; it is the more direct knob and
    // is what the timing tests pin.
    baseIntervalMs: positiveOr(envConfig.musicbrainzMinIntervalMs, derivedIntervalMs),
    reserveRatio,
    // The floor can never sit above the reserve, or the low tier vanishes.
    floorRatio: Math.min(
      ratioOr(envConfig.musicbrainzFloorRatio, DEFAULT_FLOOR_RATIO),
      reserveRatio,
    ),
    breakerThreshold: positiveOr(envConfig.musicbrainzBreakerThreshold, DEFAULT_BREAKER_THRESHOLD),
    breakerCooldownMs: positiveOr(
      envConfig.musicbrainzBreakerCooldownMs,
      DEFAULT_BREAKER_COOLDOWN_MS,
    ),
  }
}

export const mbRateConfig: MbRateConfig = resolveMbRateConfig()

export type RateLimitSnapshot = {
  limit: number
  remaining: number
  /** Epoch ms at which the window resets; equal to observedAtMs when unknown. */
  resetAtMs: number
  zone: string | null
  observedAtMs: number
}

function parseResetAtMs(raw: string | null, nowMs: number): number {
  if (raw === null || raw.trim() === '') return nowMs
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) return nowMs
  // MusicBrainz sends an epoch in seconds. Some gateways send a delta instead;
  // a value this small cannot be an epoch, so treat it as seconds-from-now.
  return value < 1_000_000 ? nowMs + value * 1000 : value * 1000
}

/**
 * Read MusicBrainz's rate-limit headers off a response.
 *
 * MusicBrainz answers with whichever bucket is closest to exhaustion, so
 * `limit` is NOT a constant: a per-IP zone (limit ~400 over a few seconds) and
 * a shared `x-ratelimit-zone: global` bucket (limit ~15) both appear in
 * practice, and the global zone's `remaining` moves with worldwide traffic
 * rather than ours. That is fine, and in fact the point -- the binding
 * constraint is exactly what we should be pacing against.
 *
 * Returns null when the headers are absent or unusable, so "no budget known"
 * is never confused with "budget exhausted".
 */
export function parseRateLimitHeaders(headers: Headers, nowMs: number): RateLimitSnapshot | null {
  const rawLimit = headers.get('x-ratelimit-limit')
  const rawRemaining = headers.get('x-ratelimit-remaining')
  if (rawLimit === null || rawRemaining === null) return null

  const limit = Number(rawLimit)
  const remaining = Number(rawRemaining)
  if (!Number.isFinite(limit) || limit <= 0) return null
  if (!Number.isFinite(remaining)) return null

  return {
    limit,
    // A negative remaining means we are already over; it is not a credit.
    remaining: Math.max(0, remaining),
    resetAtMs: parseResetAtMs(headers.get('x-ratelimit-reset'), nowMs),
    zone: headers.get('x-ratelimit-zone'),
    observedAtMs: nowMs,
  }
}

export type RateLimitTier = 'unknown' | 'normal' | 'low' | 'floor'

export type ThrottleDecision = {
  tier: RateLimitTier
  /** Extra milliseconds to hold inside the rate gate, on top of the base interval. */
  holdMs: number
  /** Human-readable, used for logs and for the schedulers' skip message. */
  reason: string
}

/**
 * Decide how hard to yield, given the last budget MusicBrainz reported.
 *
 * Pure, so the tiers can be asserted in milliseconds rather than inferred from
 * call counts.
 */
export function throttleDecision(
  snapshot: RateLimitSnapshot | null,
  nowMs: number,
  config: MbRateConfig = mbRateConfig,
): ThrottleDecision {
  const maxLowHoldMs = Math.round((LOW_TIER_MAX_MULTIPLIER - 1) * config.baseIntervalMs)

  if (!snapshot) {
    return { tier: 'unknown', holdMs: 0, reason: 'no rate-limit headers seen yet' }
  }
  if (nowMs - snapshot.observedAtMs > SNAPSHOT_STALE_MS) {
    // Never let one old floor reading pin traffic to the floor forever.
    return { tier: 'unknown', holdMs: 0, reason: 'last rate-limit observation is stale' }
  }

  const fraction = snapshot.remaining / snapshot.limit
  const budgetText = `${snapshot.remaining}/${snapshot.limit}`
  const pct = Math.round(fraction * 100)

  if (fraction >= config.reserveRatio) {
    return { tier: 'normal', holdMs: 0, reason: `budget healthy (${budgetText}, ${pct}%)` }
  }

  if (fraction >= config.floorRatio) {
    // Ramp rather than step, so the slowdown is proportional to the pressure
    // and there is no cliff at the reserve boundary.
    const span = config.reserveRatio - config.floorRatio
    const depth = span > 0 ? (config.reserveRatio - fraction) / span : 1
    const holdMs = Math.round(Math.min(Math.max(depth, 0), 1) * maxLowHoldMs)
    return { tier: 'low', holdMs, reason: `budget low (${budgetText}, ${pct}%)` }
  }

  // Below the hard floor: hold until MusicBrainz's window resets, but never
  // less than the deepest low-tier hold (the reset is often only a second or
  // two away, and yielding for 1s while sitting at 2% is not yielding at all),
  // and never more than MAX_ADAPTIVE_HOLD_MS so a bogus header cannot wedge
  // the client.
  const untilResetMs = snapshot.resetAtMs - nowMs
  const holdMs = Math.min(Math.max(untilResetMs, maxLowHoldMs), MAX_ADAPTIVE_HOLD_MS)
  const resetsInSec = Math.max(0, Math.ceil(untilResetMs / 1000))
  return {
    tier: 'floor',
    holdMs,
    reason: `budget depleted (${budgetText}), window resets in ${resetsInSec}s`,
  }
}

// Single shared rate gate. Every subsystem (pipeline, library sync, discovery
// modes, routes) funnels through this one queue so concurrent runs can't sum
// past the ceiling. The interval is the FIXED floor of protection; the adaptive
// hold below stacks on top of it.
const sharedQueue = new PQueue({
  concurrency: 1,
  interval: mbRateConfig.baseIntervalMs,
  intervalCap: 1,
})

// Latest budget MusicBrainz reported, shared by every client instance.
let budget: RateLimitSnapshot | null = null
let lastLoggedTier: RateLimitTier = 'unknown'

/** The live budget, for diagnostics and for the schedulers. */
export function musicBrainzRateLimitSnapshot(): RateLimitSnapshot | null {
  return budget
}

// Shared rate-limit cooldown. A 429/503 is MusicBrainz telling the whole client
// it is over the limit, not just the one request that happened to be in flight.
// Every request issued while a cooldown is active waits it out before it may
// enter the rate gate, so a storm cannot be kept alive by sibling calls (e.g.
// the library reconciler fans getReleaseGroups out over every MB candidate).
// It is a plain timestamp rather than queue.pause() so it is self-healing: a
// lost timer cannot wedge MB traffic permanently.
let cooldownUntil = 0

// Circuit breaker, layered on the same timestamp. `cooldownUntil` on its own
// only ever holds seconds, which is worth waiting out in place. A breaker-
// length cooldown is minutes, which is NOT: parking a whole library sync for
// ten minutes inside waitOutCooldown would be its own outage. So `breakerUntil`
// marks a cooldown that requests fail fast against instead of waiting on.
let consecutiveRateLimited = 0
let breakerUntil = 0

export class MusicBrainzCircuitOpenError extends Error {
  readonly retryAtMs: number
  constructor(retryAtMs: number) {
    const seconds = Math.max(0, Math.ceil((retryAtMs - Date.now()) / 1000))
    super(
      `MusicBrainz circuit breaker open for another ${seconds}s (too many consecutive rate-limited responses)`,
    )
    this.name = 'MusicBrainzCircuitOpenError'
    this.retryAtMs = retryAtMs
  }
}

function armCooldown(untilMs: number): void {
  cooldownUntil = Math.max(cooldownUntil, untilMs)
}

/** Arm the long cooldown. Returns nothing; callers check `breakerUntil`. */
function armBreaker(nowMs: number): void {
  const until = nowMs + mbRateConfig.breakerCooldownMs
  armCooldown(until)
  breakerUntil = Math.max(breakerUntil, until)
  // Reset the counter so the breaker re-arms only after another full run of
  // rate-limited responses once this cooldown expires.
  consecutiveRateLimited = 0
  console.warn(
    `[musicbrainz] circuit breaker armed: ${mbRateConfig.breakerThreshold} consecutive rate-limited responses; holding all MusicBrainz traffic for ${Math.round(mbRateConfig.breakerCooldownMs / 60_000)}m`,
  )
}

/** Count a 429/503. Returns true when this one armed the breaker. */
function noteRateLimited(nowMs: number): boolean {
  consecutiveRateLimited += 1
  if (consecutiveRateLimited < mbRateConfig.breakerThreshold) return false
  armBreaker(nowMs)
  return true
}

function noteRequestSucceeded(): void {
  consecutiveRateLimited = 0
}

async function waitOutCooldown(): Promise<void> {
  let remaining = cooldownUntil - Date.now()
  while (remaining > 0) {
    await sleep(Math.ceil(Math.min(remaining, MAX_BACKOFF_MS)))
    remaining = cooldownUntil - Date.now()
  }
}

/** Hold inside the rate gate for as long as the live budget says we should. */
async function applyAdaptiveHold(): Promise<void> {
  const decision = throttleDecision(budget, Date.now())
  if (decision.holdMs <= 0) {
    lastLoggedTier = decision.tier
    return
  }
  // Log the transition only, not every request: a depleted budget would
  // otherwise produce one warning per call for as long as it lasts.
  if (decision.tier !== lastLoggedTier) {
    console.warn(
      `[musicbrainz] yielding to the shared rate limit: ${decision.reason}; holding ${decision.holdMs}ms between requests`,
    )
    lastLoggedTier = decision.tier
  }
  await sleep(decision.holdMs)
}

/**
 * Why background work should not start right now, or null when it may.
 *
 * Consumed by the library schedulers: starting a long MusicBrainz-heavy job
 * against an exhausted budget can only produce `leaving unreconciled` rows
 * while pushing the shared household budget further down.
 */
export function musicBrainzDeferralReason(nowMs: number = Date.now()): string | null {
  const breakerRemainingMs = breakerUntil - nowMs
  if (breakerRemainingMs > 0) {
    return `MusicBrainz circuit breaker armed for another ${Math.ceil(breakerRemainingMs / 60_000)}m`
  }
  const decision = throttleDecision(budget, nowMs)
  if (decision.tier === 'floor') return `MusicBrainz ${decision.reason}`
  return null
}

// Test-only reset; all of the above is module state shared by every client, so
// it would otherwise leak across tests (and across a rewound fake clock).
export function resetMusicBrainzRateLimitForTests(): void {
  cooldownUntil = 0
  breakerUntil = 0
  consecutiveRateLimited = 0
  budget = null
  lastLoggedTier = 'unknown'
}

export function createMusicBrainzClient() {
  const queue = sharedQueue

  async function fetchOnce(path: string): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      return await fetch(`${BASE_URL}${path}`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  // Only the network round-trip is queued; the backoff sleep happens between
  // attempts OUTSIDE the rate-limited slot, and each attempt re-enqueues. This
  // stops one retrying request (e.g. during a 503 storm) from holding the single
  // concurrency slot and stalling all other MB traffic for its whole backoff.
  async function request<T>(path: string): Promise<T> {
    let lastErr: unknown
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        // Checked before anything else, including the cooldown wait: once the
        // breaker is armed, in-flight work must STOP re-queueing rather than
        // grind through its remaining per-request retries, and it must not sit
        // in waitOutCooldown for the whole multi-minute cooldown either.
        if (breakerUntil > Date.now()) {
          throw new MusicBrainzCircuitOpenError(breakerUntil)
        }

        // Observed before entering the gate, so the cooldown is spent outside
        // the single concurrency slot (see the comment above).
        await waitOutCooldown()
        const res = (await queue.add(async () => {
          // The adaptive hold belongs INSIDE the slot: it is the rate gate, so
          // it must serialise with it. The retry backoff below stays outside.
          await applyAdaptiveHold()
          return fetchOnce(path)
        })) as Response

        // Every response carries the live budget, including the ones that say
        // no. Record it before branching.
        const snapshot = parseRateLimitHeaders(res.headers, Date.now())
        if (snapshot) budget = snapshot

        if (res.ok) {
          noteRequestSucceeded()
          return (await res.json()) as T
        }

        // Non-retryable HTTP status: surface immediately.
        if (!TRANSIENT_STATUSES.has(res.status)) {
          throw new Error(`MusicBrainz HTTP ${res.status} for ${path}`)
        }

        const retryAfter = parseRetryAfterMs(res.headers.get('retry-after'))
        const backoff = backoffDelayMs(attempt, retryAfter)

        // Throttled: hold every other MB caller back too, even on the final
        // attempt -- the limiter does not care that we have given up on this
        // particular path.
        if (RATE_LIMIT_STATUSES.has(res.status)) {
          armCooldown(Date.now() + backoff)
          if (noteRateLimited(Date.now())) {
            // Sustained rate limiting, not a hiccup. Abandon the remaining
            // retries: another three attempts on this one path cannot help,
            // and every sibling request is about to do the same.
            throw new MusicBrainzCircuitOpenError(breakerUntil)
          }
        }

        // Final failed attempt throws out.
        if (attempt === MAX_RETRIES) {
          throw new Error(`MusicBrainz HTTP ${res.status} for ${path}`)
        }

        console.warn(
          `[musicbrainz] HTTP ${res.status} for ${path} (attempt ${attempt + 1}/${MAX_RETRIES + 1}); retrying in ${Math.round(backoff)}ms`,
        )
        await sleep(backoff)
        lastErr = new Error(`MusicBrainz HTTP ${res.status} for ${path}`)
      } catch (err) {
        // Network/timeout errors are retryable. The final attempt rethrows.
        const retryable =
          err instanceof Error &&
          (err.name === 'AbortError' ||
            err instanceof TypeError ||
            /fetch failed|network|ECONN|ENOTFOUND|ETIMEDOUT|ECONNRESET/i.test(err.message))
        if (!retryable || attempt === MAX_RETRIES) {
          throw err
        }
        const backoff = backoffDelayMs(attempt)
        console.warn(
          `[musicbrainz] ${err instanceof Error ? err.message : String(err)} for ${path} (attempt ${attempt + 1}/${MAX_RETRIES + 1}); retrying in ${Math.round(backoff)}ms`,
        )
        await sleep(backoff)
        lastErr = err
      }
    }
    // Unreachable under normal flow - loop either returns or throws above.
    throw lastErr instanceof Error ? lastErr : new Error(`MusicBrainz request failed for ${path}`)
  }

  function lookupArtist(mbid: string): Promise<MBArtist> {
    const params = new URLSearchParams({ inc: 'tags+url-rels', fmt: 'json' })
    return request<MBArtist>(`/artist/${mbid}?${params}`)
  }

  // Artist-artist relations (member-of-band, collaboration, aliases, etc.) for
  // the artist-relationships discovery mode. One request per artist.
  function lookupArtistRelations(mbid: string): Promise<MBArtist> {
    const params = new URLSearchParams({ inc: 'artist-rels', fmt: 'json' })
    return request<MBArtist>(`/artist/${mbid}?${params}`)
  }

  function searchArtist(query: string): Promise<MBSearchResult> {
    const params = new URLSearchParams({ query, fmt: 'json' })
    return request<MBSearchResult>(`/artist/?${params}`)
  }

  async function getReleaseGroups(
    artistMbid: string,
    types: readonly string[] = ['album', 'ep', 'single'],
  ): Promise<MBReleaseGroup[]> {
    const params = new URLSearchParams({
      artist: artistMbid,
      type: types.join('|'),
      fmt: 'json',
      limit: '100',
    })
    const data = await request<{
      'release-groups': Array<{
        id: string
        title: string
        'primary-type'?: string
        'first-release-date'?: string
      }>
    }>(`/release-group?${params}`)
    return (data['release-groups'] ?? []).map((rg) => ({
      id: rg.id,
      title: rg.title,
      type: rg['primary-type'] ?? 'Other',
      firstReleaseDate: rg['first-release-date'],
    }))
  }

  async function getRecordings(artistMbid: string, limit = 25): Promise<MBRecording[]> {
    const params = new URLSearchParams({
      artist: artistMbid,
      fmt: 'json',
      limit: String(limit),
    })
    const data = await request<{
      recordings?: Array<{
        id: string
        title: string
        isrcs?: string[]
      }>
    }>(`/recording?${params}`)

    return (data.recordings ?? []).map((recording) => ({
      id: recording.id,
      title: recording.title,
      isrcs: recording.isrcs,
    }))
  }

  async function lookupRecording(mbid: string): Promise<RecordingArtistCredit | null> {
    const params = new URLSearchParams({ inc: 'artist-credits', fmt: 'json' })
    let data: MBRecordingLookup
    try {
      data = await request<MBRecordingLookup>(`/recording/${mbid}?${params}`)
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) return null
      throw err
    }
    const credit = data['artist-credit']?.[0]
    if (!credit) return null
    return {
      recordingMbid: mbid,
      artistMbid: credit.artist.id,
      artistName: credit.artist.name,
    }
  }

  function extractStreamingUrls(relations: MBRelation[]): StreamingUrls {
    const result: StreamingUrls = {}

    for (const rel of relations) {
      if (!rel.url?.resource) continue
      if (!STREAMING_TYPES.has(rel.type)) continue

      const resource = rel.url.resource

      for (const [pattern, key] of STREAMING_PATTERNS) {
        if (pattern.test(resource) && result[key] === undefined) {
          result[key] = resource
          break
        }
      }
    }

    return result
  }

  return {
    lookupArtist,
    lookupArtistRelations,
    searchArtist,
    getReleaseGroups,
    getRecordings,
    lookupRecording,
    extractStreamingUrls,
  }
}
