// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setMaintenance } from '@/core/ops/maintenance'

// The library-health scan is one of the two independent MusicBrainz consumers
// inside digarr (the other is library_sync/library-reconcile). It runs every 6h
// AND at process start, so a `docker restart` does not stop it -- which is the
// most likely source of the 8,324 x 503 seen in 48h.
//
// Starting a long MB-heavy scan while the budget is already depleted, or while
// the client's circuit breaker is armed, can only produce `leaving
// unreconciled` rows while pushing the shared household budget further down.
// The tick must check first.
//
// `musicBrainzDeferralReason` is stubbed here so the scheduler's own decision
// is tested in isolation. That the REAL client produces that reason after a
// real 503 storm is pinned in tests/core/clients/musicbrainz-budget.test.ts.
const deferral = vi.hoisted(() => ({ value: null as string | null }))

vi.mock('@/core/clients/musicbrainz', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/clients/musicbrainz')>()
  return { ...actual, musicBrainzDeferralReason: () => deferral.value }
})

const { startLibraryHealthScheduler } = await import('@/core/library/health-scheduler')

function makeMockHealth() {
  return {
    startScan: vi.fn(),
  }
}

describe('startLibraryHealthScheduler', () => {
  let cron: ReturnType<typeof startLibraryHealthScheduler> | undefined
  let logs: string[]

  beforeEach(() => {
    logs = []
    deferral.value = null
    setMaintenance(false)
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    })
  })

  afterEach(() => {
    cron?.stop()
    cron = undefined
    setMaintenance(false)
    vi.restoreAllMocks()
  })

  it('constructs cleanly for the default 6h interval', () => {
    const health = makeMockHealth()
    expect(() => {
      cron = startLibraryHealthScheduler({
        intervalHours: 6,
        libraryHealth: health,
      })
    }).not.toThrow()
  })

  it('runs the scan when MusicBrainz has headroom', async () => {
    const health = makeMockHealth()
    cron = startLibraryHealthScheduler({ intervalHours: 6, libraryHealth: health })

    await cron.trigger()

    expect(health.startScan).toHaveBeenCalledTimes(1)
  })

  it('skips the tick while the MusicBrainz circuit breaker is armed', async () => {
    deferral.value = 'MusicBrainz circuit breaker armed for another 9m'
    const health = makeMockHealth()
    cron = startLibraryHealthScheduler({ intervalHours: 6, libraryHealth: health })

    await cron.trigger()

    expect(health.startScan).not.toHaveBeenCalled()
    expect(logs.join('\n')).toContain('[library-health-scheduler] tick skipped')
    expect(logs.join('\n')).toContain('circuit breaker armed for another 9m')
  })

  it('skips the tick while the MusicBrainz budget is depleted', async () => {
    deferral.value = 'MusicBrainz budget depleted (33/1200), window resets in 45s'
    const health = makeMockHealth()
    cron = startLibraryHealthScheduler({ intervalHours: 6, libraryHealth: health })

    await cron.trigger()

    expect(health.startScan).not.toHaveBeenCalled()
    expect(logs.join('\n')).toContain('33/1200')
  })

  it('still skips for maintenance, and says so', async () => {
    setMaintenance(true)
    const health = makeMockHealth()
    cron = startLibraryHealthScheduler({ intervalHours: 6, libraryHealth: health })

    await cron.trigger()

    expect(health.startScan).not.toHaveBeenCalled()
    expect(logs.join('\n')).toContain('maintenance in progress')
  })

  it('resumes scanning once the deferral clears', async () => {
    deferral.value = 'MusicBrainz circuit breaker armed for another 9m'
    const health = makeMockHealth()
    cron = startLibraryHealthScheduler({ intervalHours: 6, libraryHealth: health })

    await cron.trigger()
    expect(health.startScan).not.toHaveBeenCalled()

    deferral.value = null
    await cron.trigger()
    expect(health.startScan).toHaveBeenCalledTimes(1)
  })
})
