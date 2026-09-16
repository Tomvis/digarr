// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeAlbumTitle, normalizeArtistName } from '@/core/matching/normalize'
import { criticScoreKey } from '@/core/pipeline/score'
import type { Database } from '@/db'
import { findMusicRaterScoresByNames, upsertMusicRaterAlbums } from '@/db/queries/music-rater'
import { users } from '@/db/schema'
import { makeTestDb } from '../../helpers/test-db'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

/**
 * Real-DB coverage for the join between how `music_rater_albums` rows get
 * their composite lookup key built (`findMusicRaterScoresByNames`,
 * db/queries/music-rater.ts) and how the scorer builds the SAME key
 * (`criticScoreKey`, core/pipeline/score.ts).
 *
 * Both sides apply `normalizeArtistName`/`normalizeAlbumTitle` -- that part
 * cannot drift, it's one shared import. What CAN drift silently is the
 * hand-written composite-string template on each side: the separator and
 * field order in `${row.artistNameNormalized}::${row.albumTitleNormalized}`
 * (music-rater.ts:143) versus `${normalizeArtistName(...)}::${normalizeAlbumTitle(...)}`
 * (score.ts's criticScoreKey). Nothing else in the suite exercises the real
 * query -- score.test.ts's diacritic test builds its map via criticScoreKey
 * itself, and the orchestrator test mocks this function out entirely -- so a
 * divergence here would silently stop every critic score from applying, with
 * album scores just quietly lower and nothing pointing at the cause.
 */
describe('findMusicRaterScoresByNames (real db)', () => {
  let db: Database
  let close: () => Promise<void>
  let userId: number

  beforeEach(async () => {
    const testDb = await makeTestDb()
    db = testDb.db as unknown as Database
    close = testDb.close
    const [user] = await db
      .insert(users)
      .values({ username: 'critic-test', passwordHash: 'x' })
      .returning({ id: users.id })
    if (!user) throw new Error('test user was not created')
    userId = user.id
  })

  afterEach(async () => {
    await close()
  })

  it('keys its returned map exactly the way criticScoreKey composes it, for a name with a diacritic and a ligature', async () => {
    // Raw names as they'd arrive from music-rater's API, unnormalized.
    const artistNameRaw = 'Sigur Rós'
    const albumTitleRaw = 'Ágætis Byrjun'

    // Seed exactly the way sync.ts does: normalise with digarr's own
    // functions before writing (see core/music-rater/sync.ts's toRow).
    await upsertMusicRaterAlbums(db, userId, [
      {
        musicRaterAlbumId: 1,
        artistNameRaw,
        albumTitleRaw,
        artistNameNormalized: normalizeArtistName(artistNameRaw),
        albumTitleNormalized: normalizeAlbumTitle(albumTitleRaw),
        releaseYear: 1999,
        maxScoreRatio: 0.95,
        drValue: null,
        genreSlugs: [],
        sourceSites: ['amg'],
      },
    ])

    const result = await findMusicRaterScoresByNames(db, userId, [
      {
        artistNormalized: normalizeArtistName(artistNameRaw),
        titleNormalized: normalizeAlbumTitle(albumTitleRaw),
      },
    ])

    // The real assertion: score.ts's criticScoreKey, built from the RAW
    // names, must be the exact key the real query's returned map uses. If
    // either side's join template (separator, field order) ever diverges,
    // this becomes a silent miss (`.get` returns undefined) rather than a
    // throw -- so assert the looked-up value, not just key membership.
    const expectedKey = criticScoreKey(artistNameRaw, albumTitleRaw)
    expect(result.get(expectedKey)).toBe(0.95)
  })

  it('returns nothing for a name that was never synced', async () => {
    const result = await findMusicRaterScoresByNames(db, userId, [
      {
        artistNormalized: normalizeArtistName('Nobody'),
        titleNormalized: normalizeAlbumTitle('Nothing'),
      },
    ])
    expect(result.size).toBe(0)
  })
})
