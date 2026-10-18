import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Database } from '@/db'
import { getTopGenres } from '@/db/queries/analytics'
import { getRecentActivity, getTopGenresForUser } from '@/db/queries/dashboard'
import { getGenreArtists } from '@/db/queries/recommendations'
import { artists, recommendationBatches, recommendations, users } from '@/db/schema'
import { makeTestDb } from '../../helpers/test-db'

// MUSIC-130: genre views are artist-level, so a song rec must not count its
// artist as a recommended/approved artist in a genre.
describe('track recs in genre, dashboard and analytics views', () => {
  let fixture: Awaited<ReturnType<typeof makeTestDb>>
  let db: Database

  beforeAll(async () => {
    fixture = await makeTestDb()
    db = fixture.db as unknown as Database
    await db.insert(users).values({ id: 1, username: 'views', passwordHash: 'test' })
    const [batch] = await db.insert(recommendationBatches).values({}).returning()
    if (!batch) throw new Error('Missing batch fixture')
    const [artistRow, trackRow] = await db
      .insert(artists)
      .values([
        { mbid: '00000000-0000-0000-0000-000000000001', name: 'Artist Rec', genres: ['shared'] },
        {
          mbid: '00000000-0000-0000-0000-000000000002',
          name: 'Song Only',
          genres: ['shared', 'song-only'],
        },
      ])
      .returning()
    if (!artistRow || !trackRow) throw new Error('Missing artist fixtures')
    const base = { userId: 1, batchId: batch.id, score: 0.8 }
    await db.insert(recommendations).values([
      {
        ...base,
        artistId: artistRow.id,
        status: 'approved',
        actedOnAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        ...base,
        artistId: trackRow.id,
        status: 'approved',
        actedOnAt: new Date('2026-01-02T00:00:00Z'),
        kind: 'track',
        recommendedRecordingMbid: 'rec-1',
        recommendedTrackTitle: 'The Song',
      },
      {
        ...base,
        artistId: trackRow.id,
        status: 'pending',
        kind: 'track',
        recommendedRecordingMbid: 'rec-2',
        recommendedTrackTitle: 'Other Song',
      },
    ])
  }, 30_000)

  afterAll(async () => {
    await fixture?.close()
  })

  it.each(['recommended', 'trending', 'deep_cuts'] as const)(
    'genre %s view lists only artist-level recs',
    async (view) => {
      const rows = await getGenreArtists(db, 'shared', view, 20, 1)
      expect(rows.map((r) => r.name)).not.toContain('Song Only')
    },
  )

  it('dashboard taste ignores song approvals', async () => {
    const taste = await getTopGenresForUser(db, 1)
    expect(taste).toEqual([{ genre: 'shared', count: 1, percentage: 100 }])
  })

  it('analytics top genres ignore song recs', async () => {
    const genres = await getTopGenres(db)
    expect(genres.map((g) => [g.genre, g.count])).toEqual([['shared', 1]])
  })

  it('dashboard activity names the song for a track rec', async () => {
    const activity = await getRecentActivity(db, 1, false, 5)
    const recs = activity.filter((e) => e.type === 'approved')
    expect(recs.map((e) => e.data)).toEqual([
      expect.objectContaining({ artistName: 'Song Only', trackTitle: 'The Song' }),
      expect.not.objectContaining({ trackTitle: expect.anything() }),
    ])
  })
})
