// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createCriticallyAcclaimedMode } from '@/core/discovery-modes/modes/critically-acclaimed'

function request(settings: Record<string, unknown> = {}) {
  return { userId: 1, normalizedSettings: settings } as never
}

const acclaimed = [
  { id: 10, artistNameRaw: 'Sigur Rós', albumTitleRaw: 'Ágætis Byrjun', releaseYear: 1999 },
  { id: 11, artistNameRaw: 'Boards of Canada', albumTitleRaw: 'Geogaddi', releaseYear: 2002 },
]

describe('createCriticallyAcclaimedMode', () => {
  it('emits a release candidate for each resolved album', async () => {
    const mode = createCriticallyAcclaimedMode({
      getUnresolvedAcclaimedAlbums: vi.fn().mockResolvedValue(acclaimed),
      resolveArtistMbid: vi.fn(async (name: string) => `mbid-${name}`),
      matchAlbum: vi.fn(async () => ({ releaseGroupId: 'rg-1', title: 'T' })),
      markResolved: vi.fn().mockResolvedValue(undefined),
    })

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
    const mode = createCriticallyAcclaimedMode({
      getUnresolvedAcclaimedAlbums: vi.fn().mockResolvedValue([acclaimed[0]]),
      resolveArtistMbid: vi.fn(async () => null),
      matchAlbum: vi.fn(),
      markResolved,
    })

    const { candidates } = await mode.executor(request())

    expect(candidates).toHaveLength(0)
    expect(markResolved).toHaveBeenCalledWith(10, {
      artistMbid: null,
      releaseGroupMbid: null,
    })
  })

  it('does not emit a candidate when the title does not match a release group', async () => {
    const markResolved = vi.fn().mockResolvedValue(undefined)
    const mode = createCriticallyAcclaimedMode({
      getUnresolvedAcclaimedAlbums: vi.fn().mockResolvedValue([acclaimed[0]]),
      resolveArtistMbid: vi.fn(async () => 'mbid-a'),
      matchAlbum: vi.fn(async () => ({ title: 'T' })),
      markResolved,
    })

    const { candidates } = await mode.executor(request())

    expect(candidates).toHaveLength(0)
    expect(markResolved).toHaveBeenCalledWith(10, {
      artistMbid: 'mbid-a',
      releaseGroupMbid: null,
    })
  })

  it('one album failing does not abort the rest of the slice', async () => {
    const mode = createCriticallyAcclaimedMode({
      getUnresolvedAcclaimedAlbums: vi.fn().mockResolvedValue(acclaimed),
      resolveArtistMbid: vi
        .fn()
        .mockRejectedValueOnce(new Error('MB down'))
        .mockResolvedValueOnce('mbid-b'),
      matchAlbum: vi.fn(async () => ({ releaseGroupId: 'rg-2', title: 'T' })),
      markResolved: vi.fn().mockResolvedValue(undefined),
    })

    const { candidates } = await mode.executor(request())

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ artistMbid: 'mbid-b' })
  })

  it('honours maxAlbumsPerRun from the request settings', async () => {
    const getUnresolvedAcclaimedAlbums = vi.fn().mockResolvedValue([])
    const mode = createCriticallyAcclaimedMode({
      getUnresolvedAcclaimedAlbums,
      resolveArtistMbid: vi.fn(),
      matchAlbum: vi.fn(),
      markResolved: vi.fn(),
    })

    await mode.executor(request({ maxAlbumsPerRun: 5 }))

    expect(getUnresolvedAcclaimedAlbums).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ limit: 5 }),
    )
  })
})
