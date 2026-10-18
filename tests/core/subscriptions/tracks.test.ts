// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { StoreDb } from '@/core/pipeline/store'
import { selectTracks, storeTracks } from '@/core/subscriptions/tracks'
import type { MusicBrainzClient } from '@/core/subscriptions/types'
import type { DiscoveredTrack } from '@/core/types'

function track(over: Partial<DiscoveredTrack> = {}): DiscoveredTrack {
  return {
    artistName: 'A',
    artistMbid: 'a-1',
    title: 'T',
    recordingMbid: 'r-1',
    album: 'Alb',
    coverReleaseMbid: 'c-1',
    position: 0,
    total: 50,
    source: 'weekly-jams',
    ...over,
  }
}

describe('selectTracks', () => {
  const base = { known: new Set<string>(), threshold: 0 }

  it('drops tracks missing recording or artist mbid', async () => {
    const out = await selectTracks(
      [track({ recordingMbid: undefined }), track({ artistMbid: undefined }), track()],
      base,
    )
    expect(out).toHaveLength(1)
  })

  it('dedupes by recording mbid (first wins) and drops known', async () => {
    const out = await selectTracks(
      [
        track({ title: 'first' }),
        track({ title: 'second', position: 1 }),
        track({ recordingMbid: 'r-2' }),
      ],
      { ...base, known: new Set(['r-2']) },
    )
    expect(out.map((t) => t.title)).toEqual(['first'])
  })

  it('drops owned tracks; owned check errors keep the track', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const isOwned = vi.fn(async (_a: string, title: string) => {
      if (title === 'boom') throw new Error('down')
      return title === 'owned'
    })
    const out = await selectTracks(
      [
        track({ title: 'owned', recordingMbid: 'r-1' }),
        track({ title: 'boom', recordingMbid: 'r-2' }),
        track({ title: 'new', recordingMbid: 'r-3' }),
      ],
      { ...base, isOwned },
    )
    expect(out.map((t) => t.title)).toEqual(['boom', 'new'])
    warn.mockRestore()
  })

  it('scores by position, applies threshold and cap', async () => {
    const tracks = [0, 25, 49].map((p) => track({ position: p, recordingMbid: `r-${p}` }))
    const all = await selectTracks(tracks, base)
    expect(all[0]?.score).toBeCloseTo(0.85)
    expect(all[1]?.score).toBeCloseTo(0.7)
    const above = await selectTracks(tracks, { ...base, threshold: 0.7 })
    expect(above.map((t) => t.position)).toEqual([0, 25])
    const capped = await selectTracks(tracks, { ...base, cap: 1 })
    expect(capped.map((t) => t.position)).toEqual([0])
  })

  it('cap counts only non-owned tracks', async () => {
    const tracks = [0, 1, 2].map((p) =>
      track({ position: p, recordingMbid: `r-${p}`, title: `t${p}` }),
    )
    const out = await selectTracks(tracks, {
      ...base,
      cap: 1,
      isOwned: async (_a, t) => t === 't0',
    })
    expect(out.map((t) => t.title)).toEqual(['t1'])
  })
})

describe('storeTracks', () => {
  function makeDb() {
    return {
      insertBatch: vi.fn().mockResolvedValue({ id: 7 }),
      completeBatch: vi.fn().mockResolvedValue(undefined),
      failBatch: vi.fn().mockResolvedValue(undefined),
      upsertArtist: vi.fn().mockResolvedValue({ id: 42 }),
      insertRecommendation: vi.fn().mockResolvedValue(undefined),
    } as unknown as StoreDb
  }
  function makeMb(lookup?: MusicBrainzClient['lookupArtist']): MusicBrainzClient {
    return {
      lookupArtist:
        lookup ??
        vi
          .fn()
          .mockResolvedValue({ id: 'a-1', name: 'Artist', tags: [{ name: 'rock', count: 1 }] }),
      searchArtist: vi.fn(),
      extractStreamingUrls: vi.fn().mockReturnValue({}),
    }
  }

  it('upserts each artist once and inserts track recommendations', async () => {
    const db = makeDb()
    const mb = makeMb()
    const tracks = [
      { ...track(), score: 0.85 },
      { ...track({ recordingMbid: 'r-2', title: 'T2' }), score: 0.8 },
    ]
    const res = await storeTracks(tracks, db, mb, { userId: 3, subscriptionId: 5 })
    expect(res).toEqual({ batchId: 7, added: 2 })
    expect(mb.lookupArtist).toHaveBeenCalledTimes(1)
    expect(db.upsertArtist).toHaveBeenCalledTimes(1)
    expect(db.upsertArtist).toHaveBeenCalledWith(
      expect.objectContaining({ mbid: 'a-1', name: 'Artist', tags: ['rock'] }),
    )
    expect(db.insertRecommendation).toHaveBeenCalledTimes(2)
    expect(db.insertRecommendation).toHaveBeenNthCalledWith(1, {
      artistId: 42,
      batchId: 7,
      score: 0.85,
      sources: { 'weekly-jams': 0.85 },
      status: 'pending',
      userId: 3,
      kind: 'track',
      recommendedRecordingMbid: 'r-1',
      recommendedTrackTitle: 'T',
      recommendedTrackAlbum: 'Alb',
      recommendedCoverReleaseMbid: 'c-1',
    })
    expect(db.completeBatch).toHaveBeenCalledWith(7, { discovered: 2, added: 2, failed: 0 })
  })

  it('an artist lookup failure skips only that track', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = makeDb()
    const mb = makeMb(
      vi.fn(async (mbid: string) => {
        if (mbid === 'bad') throw new Error('mb down')
        return { id: mbid, name: 'Good' }
      }),
    )
    const res = await storeTracks(
      [
        { ...track({ artistMbid: 'bad' }), score: 0.8 },
        { ...track({ artistMbid: 'good', recordingMbid: 'r-2' }), score: 0.7 },
      ],
      db,
      mb,
    )
    expect(res.added).toBe(1)
    expect(db.completeBatch).toHaveBeenCalledWith(7, { discovered: 2, added: 1, failed: 1 })
    err.mockRestore()
  })
})
