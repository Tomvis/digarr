// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { MusicRaterAlbum } from '@/core/clients/music-rater'
import { syncMusicRaterCorpus } from '@/core/music-rater/sync'

function album(id: number, over: Partial<MusicRaterAlbum> = {}): MusicRaterAlbum {
  return {
    id,
    artistName: `Artist ${id}`,
    albumTitle: `Album ${id}`,
    releaseYear: 2020,
    maxScoreRatio: 0.9,
    drValue: 10,
    genreSlugs: [],
    sources: ['amg'],
    ...over,
  }
}

describe('syncMusicRaterCorpus', () => {
  it('pages until it has every row and upserts each page', async () => {
    const listScoredAlbums = vi
      .fn()
      .mockResolvedValueOnce({ items: [album(1), album(2)], total: 3 })
      .mockResolvedValueOnce({ items: [album(3)], total: 3 })
    const upsert = vi.fn().mockResolvedValue(undefined)

    const result = await syncMusicRaterCorpus({ client: { listScoredAlbums }, upsert }, 42)

    expect(result.synced).toBe(3)
    expect(listScoredAlbums).toHaveBeenCalledTimes(2)
    expect(upsert).toHaveBeenCalledTimes(2)
    expect(upsert.mock.calls[0]?.[0]).toBe(42)
  })

  it('normalises both name fields with digarr normalisers', async () => {
    const listScoredAlbums = vi.fn().mockResolvedValueOnce({
      items: [album(1, { artistName: 'Sigur Rós', albumTitle: 'Ágætis Byrjun' })],
      total: 1,
    })
    const upsert = vi.fn().mockResolvedValue(undefined)

    await syncMusicRaterCorpus({ client: { listScoredAlbums }, upsert }, 1)

    const row = upsert.mock.calls[0]?.[1][0]
    expect(row.artistNameNormalized).toBe('sigur ros')
    expect(row.albumTitleNormalized).toBe('agaetis byrjun')
    expect(row.artistNameRaw).toBe('Sigur Rós')
  })

  it('stops on an empty page rather than looping forever on a bad total', async () => {
    const listScoredAlbums = vi.fn().mockResolvedValue({ items: [], total: 9999 })
    const upsert = vi.fn().mockResolvedValue(undefined)

    const result = await syncMusicRaterCorpus({ client: { listScoredAlbums }, upsert }, 1)

    expect(result.synced).toBe(0)
    expect(listScoredAlbums).toHaveBeenCalledTimes(1)
  })

  it('lets a failure propagate so the job is marked failed', async () => {
    const listScoredAlbums = vi.fn().mockRejectedValue(new Error('401'))
    const upsert = vi.fn()

    await expect(syncMusicRaterCorpus({ client: { listScoredAlbums }, upsert }, 1)).rejects.toThrow(
      '401',
    )
    expect(upsert).not.toHaveBeenCalled()
  })
})
