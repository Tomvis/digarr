// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeAlbumTitle, normalizeArtistName } from '@/core/matching/normalize'
import { criticScoreKey } from '@/core/pipeline/score'
import type { Database } from '@/db'
import {
  findMusicRaterScoresByNames,
  getUnresolvedAcclaimedAlbums,
  isReleaseGroupOwnedByUser,
  upsertMusicRaterAlbums,
} from '@/db/queries/music-rater'
import { libraryAlbums, libraryArtists, musicRaterAlbums, users } from '@/db/schema'
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

/** Insert a music_rater_albums row with full control, bypassing the sync path. */
async function seedAcclaimedRow(
  db: Database,
  userId: number,
  overrides: {
    musicRaterAlbumId: number
    artistNameRaw?: string
    albumTitleRaw?: string
    maxScoreRatio?: number | null
    releaseYear?: number | null
    resolvedReleaseGroupMbid?: string | null
    resolvedArtistMbid?: string | null
    resolvedAt?: Date | null
  },
): Promise<number> {
  const artistNameRaw = overrides.artistNameRaw ?? `Artist ${overrides.musicRaterAlbumId}`
  const albumTitleRaw = overrides.albumTitleRaw ?? `Album ${overrides.musicRaterAlbumId}`
  const [row] = await db
    .insert(musicRaterAlbums)
    .values({
      userId,
      musicRaterAlbumId: overrides.musicRaterAlbumId,
      artistNameRaw,
      albumTitleRaw,
      artistNameNormalized: normalizeArtistName(artistNameRaw),
      albumTitleNormalized: normalizeAlbumTitle(albumTitleRaw),
      releaseYear: overrides.releaseYear ?? 2010,
      maxScoreRatio: overrides.maxScoreRatio ?? 0.9,
      drValue: null,
      genreSlugs: [],
      sourceSites: ['amg'],
      resolvedReleaseGroupMbid: overrides.resolvedReleaseGroupMbid ?? null,
      resolvedArtistMbid: overrides.resolvedArtistMbid ?? null,
      resolvedAt: overrides.resolvedAt ?? null,
    })
    .returning({ id: musicRaterAlbums.id })
  if (!row) throw new Error('test row was not created')
  return row.id
}

/** Insert a (libraryArtists, libraryAlbums) pair so an album counts as owned. */
async function seedOwnedAlbum(
  db: Database,
  userId: number | null,
  opts: { artistName: string; albumTitle: string; albumMbid?: string | null },
): Promise<void> {
  const artistMbid = crypto.randomUUID()
  await db.insert(libraryArtists).values({
    userId,
    source: 'lidarr',
    sourceArtistId: `artist-${opts.artistName}`,
    name: opts.artistName,
    nameNormalized: opts.artistName.toLowerCase(),
    mbid: artistMbid,
  })
  await db.insert(libraryAlbums).values({
    userId,
    source: 'lidarr',
    sourceAlbumId: `album-${opts.albumTitle}`,
    sourceArtistId: `artist-${opts.artistName}`,
    title: opts.albumTitle,
    titleNormalized: opts.albumTitle.toLowerCase(),
    artistMbid,
    albumMbid: opts.albumMbid === undefined ? crypto.randomUUID() : opts.albumMbid,
  })
}

/**
 * FIX 1: an album already in the user's library must never be offered as a
 * candidate to resolve, let alone recommend. Two layers, tested separately:
 * a pre-resolution name-based filter (this describe block) and a
 * post-resolution exact-MBID check (`isReleaseGroupOwnedByUser`, below).
 */
describe('getUnresolvedAcclaimedAlbums (real db)', () => {
  let db: Database
  let close: () => Promise<void>
  let userId: number

  beforeEach(async () => {
    const testDb = await makeTestDb()
    db = testDb.db as unknown as Database
    close = testDb.close
    const [user] = await db
      .insert(users)
      .values({ username: 'acclaimed-test', passwordHash: 'x' })
      .returning({ id: users.id })
    if (!user) throw new Error('test user was not created')
    userId = user.id
  })

  afterEach(async () => {
    await close()
  })

  it('excludes a corpus row whose (artist, title) name-matches an album already in the library', async () => {
    await seedOwnedAlbum(db, userId, { artistName: 'Radiohead', albumTitle: 'Kid A' })
    await seedAcclaimedRow(db, userId, {
      musicRaterAlbumId: 1,
      artistNameRaw: 'Radiohead',
      albumTitleRaw: 'Kid A',
    })
    await seedAcclaimedRow(db, userId, {
      musicRaterAlbumId: 2,
      artistNameRaw: 'Radiohead',
      albumTitleRaw: 'In Rainbows',
    })

    const result = await getUnresolvedAcclaimedAlbums(db, userId, {
      minScoreRatio: 0,
      minReleaseYear: 0,
      limit: 10,
    })

    // The owned album (Kid A) is gone; the unowned one (In Rainbows) survives.
    // This is the pre-resolution pass: it runs on names alone, BEFORE any
    // MusicBrainz call would have been spent resolving the owned row.
    expect(result.map((r) => r.albumTitleRaw)).toEqual(['In Rainbows'])
  })

  it('matches ownership by name regardless of casing/whitespace, via the shared normaliser', async () => {
    await seedOwnedAlbum(db, userId, { artistName: 'Sigur Rós', albumTitle: 'Ágætis Byrjun' })
    await seedAcclaimedRow(db, userId, {
      musicRaterAlbumId: 1,
      artistNameRaw: 'sigur rós',
      albumTitleRaw: '  Ágætis Byrjun  ',
    })

    const result = await getUnresolvedAcclaimedAlbums(db, userId, {
      minScoreRatio: 0,
      minReleaseYear: 0,
      limit: 10,
    })

    expect(result).toHaveLength(0)
  })

  it('does not exclude an album owned only by a DIFFERENT user', async () => {
    const [otherUser] = await db
      .insert(users)
      .values({ username: 'other-user', passwordHash: 'x' })
      .returning({ id: users.id })
    if (!otherUser) throw new Error('other test user was not created')

    await seedOwnedAlbum(db, otherUser.id, { artistName: 'Radiohead', albumTitle: 'Kid A' })
    await seedAcclaimedRow(db, userId, {
      musicRaterAlbumId: 1,
      artistNameRaw: 'Radiohead',
      albumTitleRaw: 'Kid A',
    })

    const result = await getUnresolvedAcclaimedAlbums(db, userId, {
      minScoreRatio: 0,
      minReleaseYear: 0,
      limit: 10,
    })

    expect(result).toHaveLength(1)
  })
})

describe('isReleaseGroupOwnedByUser (real db)', () => {
  let db: Database
  let close: () => Promise<void>
  let userId: number

  beforeEach(async () => {
    const testDb = await makeTestDb()
    db = testDb.db as unknown as Database
    close = testDb.close
    const [user] = await db
      .insert(users)
      .values({ username: 'owned-check-test', passwordHash: 'x' })
      .returning({ id: users.id })
    if (!user) throw new Error('test user was not created')
    userId = user.id
  })

  afterEach(async () => {
    await close()
  })

  it('is true for an exact release-group mbid match in the user library', async () => {
    const rgMbid = crypto.randomUUID()
    await seedOwnedAlbum(db, userId, {
      artistName: 'Boards of Canada',
      albumTitle: 'Geogaddi',
      albumMbid: rgMbid,
    })

    expect(await isReleaseGroupOwnedByUser(db, userId, rgMbid)).toBe(true)
  })

  it('is true for a global (null-owner) library row', async () => {
    const rgMbid = crypto.randomUUID()
    await seedOwnedAlbum(db, null, {
      artistName: 'Boards of Canada',
      albumTitle: 'Geogaddi',
      albumMbid: rgMbid,
    })

    expect(await isReleaseGroupOwnedByUser(db, userId, rgMbid)).toBe(true)
  })

  it('is false when no library row has that mbid', async () => {
    expect(await isReleaseGroupOwnedByUser(db, userId, crypto.randomUUID())).toBe(false)
  })
})
