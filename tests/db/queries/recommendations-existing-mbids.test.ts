import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Database } from '@/db'
import { getExistingRecommendationMbids } from '@/db/queries/recommendations'
import { artists, recommendationBatches, recommendations, users } from '@/db/schema'
import { makeTestDb } from '../../helpers/test-db'

const mbid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`

describe('getExistingRecommendationMbids on migrated PGlite', () => {
  let fixture: Awaited<ReturnType<typeof makeTestDb>>

  beforeAll(async () => {
    fixture = await makeTestDb()
    const { db } = fixture
    await db.insert(users).values([
      { id: 1, username: 'existing-one', passwordHash: 'test' },
      { id: 2, username: 'existing-two', passwordHash: 'test' },
    ])
    const [batch] = await db.insert(recommendationBatches).values({}).returning()
    if (!batch) throw new Error('Missing batch fixture')
    // 1: artist rec (user 1), 2: album rec (user 1), 3: track rec only (user 1),
    // 4: artist rec (user 2), 5: unowned artist rec, 6: artist + track recs (user 1)
    const rows: Array<{ n: number; userId: number | null; kind: string }> = [
      { n: 1, userId: 1, kind: 'artist' },
      { n: 2, userId: 1, kind: 'album' },
      { n: 3, userId: 1, kind: 'track' },
      { n: 4, userId: 2, kind: 'artist' },
      { n: 5, userId: null, kind: 'artist' },
      { n: 6, userId: 1, kind: 'artist' },
      { n: 6, userId: 1, kind: 'track' },
    ]
    const ids = new Map<number, number>()
    for (const { n, userId, kind } of rows) {
      let artistId = ids.get(n)
      if (artistId === undefined) {
        const [artist] = await db
          .insert(artists)
          .values({ mbid: mbid(n), name: `Artist ${n}` })
          .returning()
        if (!artist) throw new Error('Missing artist fixture')
        artistId = artist.id
        ids.set(n, artistId)
      }
      await db.insert(recommendations).values({
        userId,
        artistId,
        batchId: batch.id,
        score: 0.8,
        kind,
        ...(kind === 'track'
          ? { recommendedRecordingMbid: `rec-${n}`, recommendedTrackTitle: 'Song' }
          : {}),
      })
    }
  }, 30_000)

  afterAll(async () => {
    await fixture?.close()
  })

  it('excludes artists that only have track recs; keeps artist/album rows', async () => {
    const result = await getExistingRecommendationMbids(fixture.db as unknown as Database, 1)

    expect(result).toEqual(new Set([mbid(1), mbid(2), mbid(5), mbid(6)]))
  })

  it('without a user, still excludes track-only artists', async () => {
    const result = await getExistingRecommendationMbids(fixture.db as unknown as Database)

    expect(result).toEqual(new Set([mbid(1), mbid(2), mbid(4), mbid(5), mbid(6)]))
  })
})
