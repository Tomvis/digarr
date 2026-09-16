// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncOrchestrator } from '@/core/library/sync'
import { setMaintenance } from '@/core/ops/maintenance'

// library_sync fans MusicBrainz lookups out per artist (searchArtist, plus a
// getReleaseGroups per candidate during disambiguation). Starting a run while
// MB has already cut us off can only produce `leaving unreconciled` rows, so
// the tick checks the shared budget first -- same contract as the health
// scheduler. See tests/core/clients/musicbrainz-budget.test.ts for the proof
// that a real 503 storm produces this reason.
const deferral = vi.hoisted(() => ({ value: null as string | null }))

vi.mock('@/core/clients/musicbrainz', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/clients/musicbrainz')>()
  return { ...actual, musicBrainzDeferralReason: () => deferral.value }
})

const { startLibrarySyncScheduler } = await import('@/core/library/scheduler')

function makeMockOrchestrator(): SyncOrchestrator {
  return {
    syncGlobal: vi.fn(async () => ({ userId: null, results: [] })),
    syncForUser: vi.fn(async () => ({ userId: 1, results: [] })),
    syncSpecificSource: vi.fn(async () => ({
      source: 's',
      status: 'completed' as const,
      counts: {
        total: 0,
        matchedMbid: 0,
        matchedNameExact: 0,
        matchedNameAnchored: 0,
        matchedDisambiguated: 0,
        unreconciledAmbiguous: 0,
        unreconciledNoCandidate: 0,
        cacheHits: 0,
        mbApiCalls: 0,
      },
    })),
  }
}

describe('startLibrarySyncScheduler', () => {
  let cron: ReturnType<typeof startLibrarySyncScheduler> | undefined
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

  it('constructs cleanly for the default 6h interval (previously crashed)', () => {
    const orchestrator = makeMockOrchestrator()
    expect(() => {
      cron = startLibrarySyncScheduler({
        intervalHours: 6,
        orchestrator,
        listUserIds: async () => [],
      })
    }).not.toThrow()
  })

  it('constructs cleanly for 1h interval', () => {
    const orchestrator = makeMockOrchestrator()
    expect(() => {
      cron = startLibrarySyncScheduler({
        intervalHours: 1,
        orchestrator,
        listUserIds: async () => [],
      })
    }).not.toThrow()
  })

  it('constructs cleanly for 12h interval', () => {
    const orchestrator = makeMockOrchestrator()
    expect(() => {
      cron = startLibrarySyncScheduler({
        intervalHours: 12,
        orchestrator,
        listUserIds: async () => [],
      })
    }).not.toThrow()
  })

  it('caps very large intervals at 23h (croner limit)', () => {
    const orchestrator = makeMockOrchestrator()
    expect(() => {
      cron = startLibrarySyncScheduler({
        intervalHours: 48,
        orchestrator,
        listUserIds: async () => [],
      })
    }).not.toThrow()
  })

  it('falls back to 5-minute pattern for sub-hour interval (intervalHours=0)', () => {
    const orchestrator = makeMockOrchestrator()
    expect(() => {
      cron = startLibrarySyncScheduler({
        intervalHours: 0,
        orchestrator,
        listUserIds: async () => [],
      })
    }).not.toThrow()
  })

  it('syncs when MusicBrainz has headroom', async () => {
    const orchestrator = makeMockOrchestrator()
    cron = startLibrarySyncScheduler({
      intervalHours: 6,
      orchestrator,
      listUserIds: async () => [7],
    })

    await cron.trigger()

    expect(orchestrator.syncGlobal).toHaveBeenCalledTimes(1)
    expect(orchestrator.syncForUser).toHaveBeenCalledWith(7)
  })

  it('skips the tick when MusicBrainz asks us to back off', async () => {
    deferral.value = 'MusicBrainz circuit breaker armed for another 9m'
    const orchestrator = makeMockOrchestrator()
    cron = startLibrarySyncScheduler({
      intervalHours: 6,
      orchestrator,
      listUserIds: async () => [7],
    })

    await cron.trigger()

    expect(orchestrator.syncGlobal).not.toHaveBeenCalled()
    expect(orchestrator.syncForUser).not.toHaveBeenCalled()
    expect(logs.join('\n')).toContain('[library-sync-scheduler] tick skipped')
    expect(logs.join('\n')).toContain('circuit breaker armed for another 9m')
  })
})
