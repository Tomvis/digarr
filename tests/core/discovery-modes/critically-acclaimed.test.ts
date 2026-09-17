// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { CriticallyAcclaimedDeps } from '@/core/discovery-modes/modes/critically-acclaimed'
import { createCriticallyAcclaimedMode } from '@/core/discovery-modes/modes/critically-acclaimed'

function request(settings: Record<string, unknown> = {}) {
  return { userId: 1, normalizedSettings: settings } as never
}

const acclaimed = [
  { id: 10, artistNameRaw: 'Sigur Rós', albumTitleRaw: 'Ágætis Byrjun', releaseYear: 1999 },
  { id: 11, artistNameRaw: 'Boards of Canada', albumTitleRaw: 'Geogaddi', releaseYear: 2002 },
]

/**
 * Common deps shape with ownership always "not owned" and no recorded
 * failures. Typed as `CriticallyAcclaimedDeps` (not cast through `as never`)
 * so a future required dep with no default here is a COMPILE error, not a
 * silent `undefined` swallowed by the executor's per-album `catch` -- see
 * the FIX 1 note in the music-rater-followups cleanup.
 */
function baseDeps(overrides: Partial<CriticallyAcclaimedDeps> = {}): CriticallyAcclaimedDeps {
  return {
    getUnresolvedAcclaimedAlbums: vi.fn(),
    resolveArtistMbid: vi.fn(),
    matchAlbum: vi.fn(),
    markResolved: vi.fn(),
    isAlbumOwned: vi.fn().mockResolvedValue(false),
    recordResolutionFailure: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('createCriticallyAcclaimedMode', () => {
  it('has id "critically-acclaimed" and fallback availability', () => {
    const mode = createCriticallyAcclaimedMode(
      baseDeps({
        getUnresolvedAcclaimedAlbums: vi.fn(),
        resolveArtistMbid: vi.fn(),
        matchAlbum: vi.fn(),
        markResolved: vi.fn(),
      }),
    )

    expect(mode.id).toBe('critically-acclaimed')
    // Must agree with SINGLE_FLAG_MODES['critically-acclaimed'].fallbackUsed
    // === true (src/core/discovery-modes/availability.ts) -- same shape as
    // labels/charts/subsonic-starred, all of which are also 'fallback'. See
    // availability.test.ts's "is enabled as a fallback source" assertion.
    expect(mode.availability).toBe('fallback')
  })

  it('emits a release candidate for each resolved album', async () => {
    const mode = createCriticallyAcclaimedMode(
      baseDeps({
        getUnresolvedAcclaimedAlbums: vi.fn().mockResolvedValue(acclaimed),
        resolveArtistMbid: vi.fn(async (name: string) => `mbid-${name}`),
        matchAlbum: vi.fn(async () => ({ releaseGroupId: 'rg-1', title: 'T' })),
        markResolved: vi.fn().mockResolvedValue(undefined),
      }),
    )

    const { candidates } = await mode.executor(request())

    expect(candidates).toHaveLength(2)
    expect(candidates[0]).toMatchObject({
      candidateType: 'release',
      artistMbid: 'mbid-Sigur Rós',
      releaseGroupMbid: 'rg-1',
      provenanceProvider: 'music-rater',
      fallbackUsed: false,
      freshnessDate: '1999',
    })
  })

  it('stamps an unresolvable album so the cursor still advances', async () => {
    const markResolved = vi.fn().mockResolvedValue(undefined)
    const mode = createCriticallyAcclaimedMode(
      baseDeps({
        getUnresolvedAcclaimedAlbums: vi.fn().mockResolvedValue([acclaimed[0]]),
        resolveArtistMbid: vi.fn(async () => null),
        matchAlbum: vi.fn(),
        markResolved,
      }),
    )

    const { candidates } = await mode.executor(request())

    expect(candidates).toHaveLength(0)
    expect(markResolved).toHaveBeenCalledWith(10, {
      artistMbid: null,
      releaseGroupMbid: null,
    })
  })

  it('does not emit a candidate when the title does not match a release group', async () => {
    const markResolved = vi.fn().mockResolvedValue(undefined)
    const mode = createCriticallyAcclaimedMode(
      baseDeps({
        getUnresolvedAcclaimedAlbums: vi.fn().mockResolvedValue([acclaimed[0]]),
        resolveArtistMbid: vi.fn(async () => 'mbid-a'),
        matchAlbum: vi.fn(async () => ({ title: 'T' })),
        markResolved,
      }),
    )

    const { candidates } = await mode.executor(request())

    expect(candidates).toHaveLength(0)
    expect(markResolved).toHaveBeenCalledWith(10, {
      artistMbid: 'mbid-a',
      releaseGroupMbid: null,
    })
  })

  it('stamps a resolved-but-owned album as resolved, but emits no candidate', async () => {
    const markResolved = vi.fn().mockResolvedValue(undefined)
    const isAlbumOwned = vi.fn().mockResolvedValue(true)
    const mode = createCriticallyAcclaimedMode(
      baseDeps({
        getUnresolvedAcclaimedAlbums: vi.fn().mockResolvedValue([acclaimed[0]]),
        resolveArtistMbid: vi.fn(async () => 'mbid-a'),
        matchAlbum: vi.fn(async () => ({ releaseGroupId: 'rg-owned', title: 'T' })),
        markResolved,
        isAlbumOwned,
      }),
    )

    const { candidates } = await mode.executor(request())

    // The mode's whole promise is "albums you do not own yet" -- an owned
    // album must never surface as a candidate, no matter how well it
    // resolved or how high its critic score.
    expect(candidates).toHaveLength(0)
    // But it IS genuinely resolved, so it must leave the cursor exactly like
    // a normal successful resolution -- not sit there being re-checked
    // against MusicBrainz (and against the library) forever.
    expect(markResolved).toHaveBeenCalledWith(10, {
      artistMbid: 'mbid-a',
      releaseGroupMbid: 'rg-owned',
    })
    expect(isAlbumOwned).toHaveBeenCalledWith(1, 'rg-owned')
  })

  it('one album failing does not abort the rest of the slice, and records the failure without stamping', async () => {
    const markResolved = vi.fn().mockResolvedValue(undefined)
    const recordResolutionFailure = vi.fn().mockResolvedValue(undefined)
    const mode = createCriticallyAcclaimedMode(
      baseDeps({
        getUnresolvedAcclaimedAlbums: vi.fn().mockResolvedValue(acclaimed),
        resolveArtistMbid: vi
          .fn()
          .mockRejectedValueOnce(new Error('MB down'))
          .mockResolvedValueOnce('mbid-b'),
        matchAlbum: vi.fn(async () => ({ releaseGroupId: 'rg-2', title: 'T' })),
        markResolved,
        recordResolutionFailure,
      }),
    )

    const { candidates } = await mode.executor(request())

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ artistMbid: 'mbid-b' })

    // The thrown MusicBrainz error is a transient failure, not an unmatchable
    // album: it must NOT be stamped via markResolved, or a MusicBrainz outage
    // would permanently burn every album it touched out of the cursor with
    // null mbids, never to be retried. Only the album that actually resolved
    // (id 11) gets marked; the one that threw (id 10) does not appear at all.
    expect(markResolved).toHaveBeenCalledTimes(1)
    expect(markResolved).toHaveBeenCalledWith(11, {
      artistMbid: 'mbid-b',
      releaseGroupMbid: 'rg-2',
    })
    // Instead, the throw is recorded so a row that fails the SAME way every
    // run (a deterministic 400, not a transient outage) eventually leaves
    // the cursor -- see db/queries/music-rater.ts's MAX_RESOLUTION_ATTEMPTS.
    expect(recordResolutionFailure).toHaveBeenCalledTimes(1)
    expect(recordResolutionFailure).toHaveBeenCalledWith(10)
  })

  it('FIX 3: does not stamp the row when isAlbumOwned throws after a successful match', async () => {
    const markResolved = vi.fn().mockResolvedValue(undefined)
    const recordResolutionFailure = vi.fn().mockResolvedValue(undefined)
    const isAlbumOwned = vi.fn().mockRejectedValue(new Error('db down'))
    const mode = createCriticallyAcclaimedMode(
      baseDeps({
        getUnresolvedAcclaimedAlbums: vi.fn().mockResolvedValue([acclaimed[0]]),
        resolveArtistMbid: vi.fn(async () => 'mbid-a'),
        matchAlbum: vi.fn(async () => ({ releaseGroupId: 'rg-1', title: 'T' })),
        markResolved,
        isAlbumOwned,
        recordResolutionFailure,
      }),
    )

    const { candidates } = await mode.executor(request())

    expect(candidates).toHaveLength(0)
    // The critical assertion: markResolved must NOT have been called. A real
    // release-group mbid stamped here would permanently exclude this row
    // from `getUnresolvedAcclaimedAlbums` (its `isNull(resolvedReleaseGroupMbid)`
    // filter) even though no candidate was ever decided on, let alone
    // emitted -- a resolved album silently lost forever with nothing
    // pointing at it. Instead this must behave like any other throw in the
    // per-album try: caught, recorded, and retried next run.
    expect(markResolved).not.toHaveBeenCalled()
    expect(recordResolutionFailure).toHaveBeenCalledWith(10)
  })

  it('FIX 2: a rejecting recordResolutionFailure does not lose the other album in the slice', async () => {
    const markResolved = vi.fn().mockResolvedValue(undefined)
    // The bookkeeping call itself throws -- this is exactly what FIX 2
    // guards against. Unguarded, this rejection would escape the per-album
    // catch and fail the whole slice's Promise.all, losing album 11's
    // candidate too even though it resolved cleanly.
    const recordResolutionFailure = vi.fn().mockRejectedValue(new Error('db down'))
    const mode = createCriticallyAcclaimedMode(
      baseDeps({
        getUnresolvedAcclaimedAlbums: vi.fn().mockResolvedValue(acclaimed),
        resolveArtistMbid: vi
          .fn()
          .mockRejectedValueOnce(new Error('MB down'))
          .mockResolvedValueOnce('mbid-b'),
        matchAlbum: vi.fn(async () => ({ releaseGroupId: 'rg-2', title: 'T' })),
        markResolved,
        recordResolutionFailure,
      }),
    )

    const { candidates } = await mode.executor(request())

    // Album 11's candidate must still come back even though album 10's
    // resolveArtistMbid threw AND the resulting recordResolutionFailure
    // bookkeeping call also threw.
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ artistMbid: 'mbid-b' })
    expect(recordResolutionFailure).toHaveBeenCalledWith(10)
  })

  it('honours maxAlbumsPerRun from the request settings', async () => {
    const getUnresolvedAcclaimedAlbums = vi.fn().mockResolvedValue([])
    const mode = createCriticallyAcclaimedMode(
      baseDeps({
        getUnresolvedAcclaimedAlbums,
        resolveArtistMbid: vi.fn(),
        matchAlbum: vi.fn(),
        markResolved: vi.fn(),
      }),
    )

    await mode.executor(request({ maxAlbumsPerRun: 5 }))

    expect(getUnresolvedAcclaimedAlbums).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ limit: 5 }),
    )
  })
})
