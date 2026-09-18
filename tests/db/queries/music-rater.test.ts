// @vitest-environment node

import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeAlbumTitle, normalizeArtistName } from '@/core/matching/normalize'
import type { MusicRaterAlbumRow } from '@/core/music-rater/sync'
import { criticScoreKey } from '@/core/pipeline/score'
import type { Database } from '@/db'
import {
  findMusicRaterScoresByNames,
  getMusicRaterFilterOptions,
  getUnresolvedAcclaimedAlbums,
  isReleaseGroupOwnedByUser,
  markMusicRaterAlbumResolved,
  recordMusicRaterResolutionFailure,
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
        coverageTypes: [],
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

  /**
   * FIX 2 (final fix wave): the second of the two inertness properties named
   * by the spec, and the only one with no test. Rows are keyed
   * `(user_id, music_rater_album_id)`, but the LOOKUP key here is
   * `artistNameNormalized::albumTitleNormalized` -- two distinct music-rater
   * albums (different `musicRaterAlbumId`) can collapse onto the same
   * normalized key, e.g. a scored original and an unscored remaster of the
   * same artist/title. Before this branch dropped `has_score=true` from the
   * sync, the unscored one never synced at all; now it does, and "Yer Metal
   * Is Olde" is literally a retrospective column about old albums, so this
   * collision is the expected shape, not a corner case. The function's only
   * guard is `if (row.maxScoreRatio === null) continue` -- remove it and
   * whichever row the (unordered) scan happens to yield last wins, so a null
   * can clobber a real score with nothing failing anywhere.
   */
  it('FIX 2: a null-score row colliding on the same normalized key does not clobber the scored one', async () => {
    const artistNameRaw = 'Boards of Canada'
    const albumTitleRaw = 'Geogaddi'

    // Two distinct music-rater albums (different musicRaterAlbumId) that
    // normalize to the same lookup key -- e.g. a scored original (id 1) and
    // an unscored remaster (id 2) of the same artist/title.
    await upsertMusicRaterAlbums(db, userId, [
      {
        musicRaterAlbumId: 1,
        artistNameRaw,
        albumTitleRaw,
        artistNameNormalized: normalizeArtistName(artistNameRaw),
        albumTitleNormalized: normalizeAlbumTitle(albumTitleRaw),
        releaseYear: 1998,
        maxScoreRatio: 0.9,
        drValue: null,
        genreSlugs: [],
        sourceSites: ['amg'],
        coverageTypes: [],
      },
      {
        musicRaterAlbumId: 2,
        artistNameRaw,
        albumTitleRaw,
        artistNameNormalized: normalizeArtistName(artistNameRaw),
        albumTitleNormalized: normalizeAlbumTitle(albumTitleRaw),
        releaseYear: 2020,
        maxScoreRatio: null,
        drValue: null,
        genreSlugs: [],
        sourceSites: ['amg'],
        coverageTypes: ['ymio'],
      },
    ])

    const result = await findMusicRaterScoresByNames(db, userId, [
      {
        artistNormalized: normalizeArtistName(artistNameRaw),
        titleNormalized: normalizeAlbumTitle(albumTitleRaw),
      },
    ])

    // The map must hold the real score -- never null, and never simply
    // absent (which `score.ts`'s `!== undefined` guard would treat the same
    // as "no critic data", but a `null` stored under the key would sail
    // straight through as `sourceScores.criticScore = null`, a field typed
    // `number` silently holding null).
    const expectedKey = criticScoreKey(artistNameRaw, albumTitleRaw)
    expect(result.get(expectedKey)).toBe(0.9)
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
 * Build a `MusicRaterAlbumRow` for `upsertMusicRaterAlbums`, the same shape
 * `sync.ts`'s `toRow` produces -- unlike `seedAcclaimedRow` (which inserts
 * directly via `db.insert`, bypassing the upsert path entirely), this goes
 * through the real upsert, so it's what a sync-path test needs.
 */
function row(
  overrides: Partial<MusicRaterAlbumRow> & { musicRaterAlbumId: number },
): MusicRaterAlbumRow {
  const artistNameRaw = overrides.artistNameRaw ?? `Artist ${overrides.musicRaterAlbumId}`
  const albumTitleRaw = overrides.albumTitleRaw ?? `Album ${overrides.musicRaterAlbumId}`
  return {
    artistNameRaw,
    albumTitleRaw,
    artistNameNormalized: normalizeArtistName(artistNameRaw),
    albumTitleNormalized: normalizeAlbumTitle(albumTitleRaw),
    releaseYear: 2010,
    maxScoreRatio: 0.9,
    drValue: null,
    genreSlugs: [],
    sourceSites: ['amg'],
    coverageTypes: [],
    ...overrides,
  }
}

const BASE = { minScoreRatio: 0.8, minReleaseYear: 2000, limit: 25 }
const NO_FILTERS = {
  includeGenres: [],
  excludeGenres: [],
  coverageTypes: [],
  includeUnscored: false,
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

  it('excludes rows that already carry a resolved release-group mbid', async () => {
    await seedAcclaimedRow(db, userId, { musicRaterAlbumId: 1, artistNameRaw: 'Resolved Artist' })
    await seedAcclaimedRow(db, userId, {
      musicRaterAlbumId: 2,
      artistNameRaw: 'Done Artist',
      resolvedReleaseGroupMbid: crypto.randomUUID(),
      resolvedArtistMbid: crypto.randomUUID(),
      resolvedAt: new Date(),
    })

    const result = await getUnresolvedAcclaimedAlbums(db, userId, {
      minScoreRatio: 0,
      minReleaseYear: 0,
      limit: 10,
    })

    expect(result.map((r) => r.artistNameRaw)).toEqual(['Resolved Artist'])
  })

  it('orders never-attempted rows (resolvedAt null) before attempted ones, then by id', async () => {
    const now = new Date()
    const earlier = new Date(now.getTime() - 60_000)
    await seedAcclaimedRow(db, userId, {
      musicRaterAlbumId: 1,
      artistNameRaw: 'Attempted Recently',
      resolvedAt: now,
    })
    await seedAcclaimedRow(db, userId, {
      musicRaterAlbumId: 2,
      artistNameRaw: 'Attempted Earlier',
      resolvedAt: earlier,
    })
    await seedAcclaimedRow(db, userId, { musicRaterAlbumId: 3, artistNameRaw: 'Never Attempted B' })
    await seedAcclaimedRow(db, userId, { musicRaterAlbumId: 4, artistNameRaw: 'Never Attempted A' })

    const result = await getUnresolvedAcclaimedAlbums(db, userId, {
      minScoreRatio: 0,
      minReleaseYear: 0,
      limit: 10,
    })

    // nulls first (ids 3 then 4, ascending by id), then non-null resolvedAt
    // ascending (earlier before recent): id 2 before id 1.
    expect(result.map((r) => r.artistNameRaw)).toEqual([
      'Never Attempted B',
      'Never Attempted A',
      'Attempted Earlier',
      'Attempted Recently',
    ])
  })

  it('applies minScoreRatio and minReleaseYear as inclusive lower bounds', async () => {
    await seedAcclaimedRow(db, userId, {
      musicRaterAlbumId: 1,
      artistNameRaw: 'Too Low Score',
      maxScoreRatio: 0.5,
      releaseYear: 2015,
    })
    await seedAcclaimedRow(db, userId, {
      musicRaterAlbumId: 2,
      artistNameRaw: 'Too Old',
      maxScoreRatio: 0.9,
      releaseYear: 1990,
    })
    await seedAcclaimedRow(db, userId, {
      musicRaterAlbumId: 3,
      artistNameRaw: 'Exactly At Bounds',
      maxScoreRatio: 0.8,
      releaseYear: 2000,
    })

    const result = await getUnresolvedAcclaimedAlbums(db, userId, {
      minScoreRatio: 0.8,
      minReleaseYear: 2000,
      limit: 10,
    })

    expect(result.map((r) => r.artistNameRaw)).toEqual(['Exactly At Bounds'])
  })

  it('respects the limit', async () => {
    for (let i = 1; i <= 5; i++) {
      await seedAcclaimedRow(db, userId, { musicRaterAlbumId: i, artistNameRaw: `Artist ${i}` })
    }

    const result = await getUnresolvedAcclaimedAlbums(db, userId, {
      minScoreRatio: 0,
      minReleaseYear: 0,
      limit: 2,
    })

    expect(result).toHaveLength(2)
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

  /**
   * FIX 4 follow-up (review round 1, GAP 1): the ownership filter compares
   * two owned-key arrays (artist norms, title norms) via Postgres's
   * multi-arg `unnest(a[], b[])`, which pairs the two arrays POSITIONALLY --
   * row i of the first array with row i of the second. If that ever
   * regressed into a cross-join (every artist checked against every title,
   * independently), this would silently OVER-exclude: a corpus row whose
   * artist matches one owned album and whose title matches a DIFFERENT
   * owned album would be wrongly treated as owned and dropped -- the mode
   * would just quietly recommend less, with nothing pointing at the cause.
   *
   * Every other ownership test here seeds at most one owned album, so none
   * of them can distinguish correct positional pairing from a cross-join
   * bug (with only one row, "positional" and "cross-join" produce the same
   * single pair). This test seeds TWO owned albums with different
   * artist/title pairs and asserts the cross-pair corpus row -- owned by
   * neither pairing -- survives.
   */
  it('pairs owned artist/title keys positionally, not as a cross-join', async () => {
    await seedOwnedAlbum(db, userId, { artistName: 'Radiohead', albumTitle: 'Kid A' })
    await seedOwnedAlbum(db, userId, { artistName: 'Boards of Canada', albumTitle: 'Geogaddi' })
    // Not an owned pair under EITHER seeded row: artist matches row 1's
    // artist, title matches row 2's title. A cross-join bug would exclude
    // this; positional pairing must not.
    await seedAcclaimedRow(db, userId, {
      musicRaterAlbumId: 1,
      artistNameRaw: 'Radiohead',
      albumTitleRaw: 'Geogaddi',
    })

    const result = await getUnresolvedAcclaimedAlbums(db, userId, {
      minScoreRatio: 0,
      minReleaseYear: 0,
      limit: 10,
    })

    expect(result.map((r) => r.albumTitleRaw)).toEqual(['Geogaddi'])
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

  it('leaves unscored albums invisible to the mode by default', async () => {
    // A corpus row with no score is exactly what the editorial columns
    // (tymhm/sitf/ymio/lit) produce. Until includeUnscored is turned on it
    // must not be a candidate, or dropping has_score=true would silently
    // change what every existing run returns.
    await upsertMusicRaterAlbums(db, userId, [
      row({ musicRaterAlbumId: 1, maxScoreRatio: null, releaseYear: 2020 }),
      row({ musicRaterAlbumId: 2, maxScoreRatio: 0.95, releaseYear: 2020 }),
    ])

    const found = await getUnresolvedAcclaimedAlbums(db, userId, {
      minScoreRatio: 0.8,
      minReleaseYear: 2000,
      limit: 25,
    })

    expect(found).toHaveLength(1)
  })

  it('treats empty filter arrays as no constraint', async () => {
    // The default path. If this ever fails, the feature has stopped being
    // inert for every user who has not touched the new fields.
    await upsertMusicRaterAlbums(db, userId, [
      row({
        musicRaterAlbumId: 1,
        maxScoreRatio: 0.9,
        releaseYear: 2020,
        genreSlugs: ['doom-metal'],
      }),
      row({
        musicRaterAlbumId: 2,
        maxScoreRatio: 0.9,
        releaseYear: 2020,
        genreSlugs: ['power-metal'],
      }),
    ])

    const found = await getUnresolvedAcclaimedAlbums(db, userId, { ...BASE, ...NO_FILTERS })
    expect(found).toHaveLength(2)
  })

  it('includes only albums overlapping includeGenres', async () => {
    await upsertMusicRaterAlbums(db, userId, [
      row({
        musicRaterAlbumId: 1,
        maxScoreRatio: 0.9,
        releaseYear: 2020,
        albumTitleRaw: 'Doomy',
        genreSlugs: ['doom-metal'],
      }),
      row({
        musicRaterAlbumId: 2,
        maxScoreRatio: 0.9,
        releaseYear: 2020,
        albumTitleRaw: 'Powery',
        genreSlugs: ['power-metal'],
      }),
    ])

    const found = await getUnresolvedAcclaimedAlbums(db, userId, {
      ...BASE,
      ...NO_FILTERS,
      includeGenres: ['doom-metal'],
    })
    expect(found.map((r) => r.albumTitleRaw)).toEqual(['Doomy'])
  })

  it('drops albums overlapping excludeGenres', async () => {
    await upsertMusicRaterAlbums(db, userId, [
      row({
        musicRaterAlbumId: 1,
        maxScoreRatio: 0.9,
        releaseYear: 2020,
        albumTitleRaw: 'Doomy',
        genreSlugs: ['doom-metal'],
      }),
      row({
        musicRaterAlbumId: 2,
        maxScoreRatio: 0.9,
        releaseYear: 2020,
        albumTitleRaw: 'Powery',
        genreSlugs: ['power-metal'],
      }),
    ])

    const found = await getUnresolvedAcclaimedAlbums(db, userId, {
      ...BASE,
      ...NO_FILTERS,
      excludeGenres: ['power-metal'],
    })
    expect(found.map((r) => r.albumTitleRaw)).toEqual(['Doomy'])
  })

  /**
   * FIX 8 (final fix wave): `NOT (col ?| ARRAY[...])` evaluates to SQL NULL,
   * not TRUE, when `col` is itself NULL -- verified under pglite:
   * `SELECT NOT (NULL::jsonb ?| ARRAY['x']::text[])` yields NULL, so a naive
   * predicate silently DROPS the row from an exclude filter's results. An
   * album with no genres recorded overlaps nothing and must survive.
   * `upsertMusicRaterAlbums`/`toRow` always write `genreSlugs: []`, so this
   * is not reachable through the app today -- this seeds directly via
   * `db.insert`, bypassing that path, the same way a pre-existing row from
   * before genre_slugs had any writer (or migration 0054's coverage_types,
   * SQL NULL on every row until that user's first post-deploy sync) would
   * look.
   */
  it('FIX 8: an album with a NULL genre_slugs column survives an exclude-genre filter', async () => {
    const artistNameRaw = 'No Genres Recorded'
    const albumTitleRaw = 'Untagged'
    await db.insert(musicRaterAlbums).values({
      userId,
      musicRaterAlbumId: 1,
      artistNameRaw,
      albumTitleRaw,
      artistNameNormalized: normalizeArtistName(artistNameRaw),
      albumTitleNormalized: normalizeAlbumTitle(albumTitleRaw),
      releaseYear: 2020,
      maxScoreRatio: 0.9,
      genreSlugs: null,
      sourceSites: ['amg'],
    })

    const found = await getUnresolvedAcclaimedAlbums(db, userId, {
      ...BASE,
      ...NO_FILTERS,
      excludeGenres: ['doom-metal'],
    })

    expect(found.map((r) => r.artistNameRaw)).toEqual([artistNameRaw])
  })

  it('lets exclude win over include on the same album', async () => {
    // Tagged BOTH. Include says yes, exclude says no -- exclude is the
    // stronger statement, so the album must not be returned.
    await upsertMusicRaterAlbums(db, userId, [
      row({
        musicRaterAlbumId: 1,
        maxScoreRatio: 0.9,
        releaseYear: 2020,
        genreSlugs: ['progressive-metal', 'swedish-metal'],
      }),
    ])

    const found = await getUnresolvedAcclaimedAlbums(db, userId, {
      ...BASE,
      ...NO_FILTERS,
      includeGenres: ['progressive-metal'],
      excludeGenres: ['swedish-metal'],
    })
    expect(found).toHaveLength(0)
  })

  it('includes only albums overlapping coverageTypes', async () => {
    await upsertMusicRaterAlbums(db, userId, [
      row({
        musicRaterAlbumId: 1,
        maxScoreRatio: 0.9,
        releaseYear: 2020,
        albumTitleRaw: 'Missed',
        coverageTypes: ['tymhm'],
      }),
      row({
        musicRaterAlbumId: 2,
        maxScoreRatio: 0.9,
        releaseYear: 2020,
        albumTitleRaw: 'Reviewed',
        coverageTypes: ['review'],
      }),
    ])

    const found = await getUnresolvedAcclaimedAlbums(db, userId, {
      ...BASE,
      ...NO_FILTERS,
      coverageTypes: ['tymhm'],
    })
    expect(found.map((r) => r.albumTitleRaw)).toEqual(['Missed'])
  })

  it('admits unscored albums only when includeUnscored is true', async () => {
    await upsertMusicRaterAlbums(db, userId, [
      row({ musicRaterAlbumId: 1, maxScoreRatio: 0.9, releaseYear: 2020, albumTitleRaw: 'Scored' }),
      row({
        musicRaterAlbumId: 2,
        maxScoreRatio: null,
        releaseYear: 2020,
        albumTitleRaw: 'Unscored',
        coverageTypes: ['tymhm'],
      }),
    ])

    const off = await getUnresolvedAcclaimedAlbums(db, userId, { ...BASE, ...NO_FILTERS })
    expect(off.map((r) => r.albumTitleRaw)).toEqual(['Scored'])

    const on = await getUnresolvedAcclaimedAlbums(db, userId, {
      ...BASE,
      ...NO_FILTERS,
      includeUnscored: true,
    })
    expect(on.map((r) => r.albumTitleRaw).sort()).toEqual(['Scored', 'Unscored'])
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

/**
 * FIX 2: a repeatedly-throwing resolution (e.g. an artist name that 400s
 * MusicBrainz's Lucene search deterministically) must not retry forever.
 */
describe('recordMusicRaterResolutionFailure (real db)', () => {
  let db: Database
  let close: () => Promise<void>
  let userId: number

  beforeEach(async () => {
    const testDb = await makeTestDb()
    db = testDb.db as unknown as Database
    close = testDb.close
    const [user] = await db
      .insert(users)
      .values({ username: 'retry-budget-test', passwordHash: 'x' })
      .returning({ id: users.id })
    if (!user) throw new Error('test user was not created')
    userId = user.id
  })

  afterEach(async () => {
    await close()
  })

  it('below the attempt budget: increments the counter but leaves resolvedAt null (keeps retrying)', async () => {
    const id = await seedAcclaimedRow(db, userId, { musicRaterAlbumId: 1 })

    await recordMusicRaterResolutionFailure(db, id)

    const [row] = await db.select().from(musicRaterAlbums).where(eq(musicRaterAlbums.id, id))
    expect(row?.resolutionAttempts).toBe(1)
    expect(row?.resolvedAt).toBeNull()
  })

  it('at the attempt budget: stamps resolvedAt (with null mbids) so the row leaves the cursor head', async () => {
    const id = await seedAcclaimedRow(db, userId, { musicRaterAlbumId: 1 })

    // MAX_RESOLUTION_ATTEMPTS in db/queries/music-rater.ts is 3 -- three
    // consecutive throws must be enough to stop this row from being
    // reattempted on every single run.
    await recordMusicRaterResolutionFailure(db, id)
    await recordMusicRaterResolutionFailure(db, id)
    let [row] = await db.select().from(musicRaterAlbums).where(eq(musicRaterAlbums.id, id))
    expect(row?.resolvedAt).toBeNull()

    await recordMusicRaterResolutionFailure(db, id)
    ;[row] = await db.select().from(musicRaterAlbums).where(eq(musicRaterAlbums.id, id))

    expect(row?.resolutionAttempts).toBe(3)
    expect(row?.resolvedAt).not.toBeNull()
    expect(row?.resolvedArtistMbid).toBeNull()
    expect(row?.resolvedReleaseGroupMbid).toBeNull()

    // Stamped rows are the same shape as an "unmatchable" album: excluded
    // outright only by resolved_release_group_mbid, which stays null here --
    // it rotates to the back of the queue (resolvedAt no longer null) rather
    // than disappearing, exactly like a legitimate "artist not found" miss.
    const unresolved = await getUnresolvedAcclaimedAlbums(db, userId, {
      minScoreRatio: 0,
      minReleaseYear: 0,
      limit: 10,
    })
    expect(unresolved.map((r) => r.id)).toEqual([id])
  })
})

/**
 * FIX 3: the branch's own declared critical invariant -- a resync must not
 * clobber the MusicBrainz resolution state a previous run paid for -- was
 * recorded as "VERIFIED" on the strength of two code reads, with no test.
 * Nothing would fail if a future edit added resolved_at (or
 * resolution_attempts) to `upsertMusicRaterAlbums`'s onConflictDoUpdate
 * set-list while "fixing staleness".
 */
describe('upsertMusicRaterAlbums (real db) — the resolution invariant it must not clobber', () => {
  let db: Database
  let close: () => Promise<void>
  let userId: number

  beforeEach(async () => {
    const testDb = await makeTestDb()
    db = testDb.db as unknown as Database
    close = testDb.close
    const [user] = await db
      .insert(users)
      .values({ username: 'invariant-test', passwordHash: 'x' })
      .returning({ id: users.id })
    if (!user) throw new Error('test user was not created')
    userId = user.id
  })

  afterEach(async () => {
    await close()
  })

  it('a resync (re-upsert on the natural key) leaves resolved_* and resolution_attempts untouched', async () => {
    const artistNameRaw = 'Boards of Canada'
    const albumTitleRaw = 'Geogaddi'
    const row = {
      musicRaterAlbumId: 42,
      artistNameRaw,
      albumTitleRaw,
      artistNameNormalized: normalizeArtistName(artistNameRaw),
      albumTitleNormalized: normalizeAlbumTitle(albumTitleRaw),
      releaseYear: 2002,
      maxScoreRatio: 0.85,
      drValue: null,
      genreSlugs: [] as string[],
      sourceSites: ['amg'],
      coverageTypes: [] as string[],
    }

    await upsertMusicRaterAlbums(db, userId, [row])
    const [seeded] = await db
      .select()
      .from(musicRaterAlbums)
      .where(eq(musicRaterAlbums.userId, userId))
    if (!seeded) throw new Error('seeded row missing')

    const artistMbid = crypto.randomUUID()
    const releaseGroupMbid = crypto.randomUUID()
    await markMusicRaterAlbumResolved(db, seeded.id, {
      artistMbid,
      releaseGroupMbid,
    })
    await recordMusicRaterResolutionFailure(db, seeded.id) // bumps resolution_attempts to 1

    const [resolved] = await db
      .select()
      .from(musicRaterAlbums)
      .where(eq(musicRaterAlbums.id, seeded.id))
    if (!resolved) throw new Error('resolved row missing')
    expect(resolved.resolvedArtistMbid).toBe(artistMbid)
    expect(resolved.resolvedReleaseGroupMbid).toBe(releaseGroupMbid)
    expect(resolved.resolvedAt).not.toBeNull()

    // A resync sends the SAME natural key again, with a changed score (proving
    // the update branch actually runs, not just a no-op insert-skip) -- this
    // is exactly what a nightly re-sync of an already-resolved album looks like.
    await upsertMusicRaterAlbums(db, userId, [{ ...row, maxScoreRatio: 0.99 }])

    const [reupserted] = await db
      .select()
      .from(musicRaterAlbums)
      .where(eq(musicRaterAlbums.id, seeded.id))
    if (!reupserted) throw new Error('re-upserted row missing')

    // The signal DID refresh...
    expect(reupserted.maxScoreRatio).toBe(0.99)
    // ...but the MusicBrainz resolution work and the retry budget did NOT get
    // clobbered. If a future edit added resolved_at (or resolution_attempts)
    // to the upsert's onConflictDoUpdate set-list, this is what would break:
    // resolvedAt would reset to `now()` (or resolution_attempts to 0),
    // silently discarding paid-for MusicBrainz work and starting the retry
    // budget over.
    expect(reupserted.resolvedArtistMbid).toBe(artistMbid)
    expect(reupserted.resolvedReleaseGroupMbid).toBe(releaseGroupMbid)
    expect(reupserted.resolvedAt?.getTime()).toBe(resolved.resolvedAt?.getTime())
    expect(reupserted.resolutionAttempts).toBe(1)
  })
})

/**
 * The corpus-derived option lists behind `critically-acclaimed`'s
 * `resolveOptions` hook. Deliberately corpus-derived, not fetched from
 * music-rater -- see the function's own docstring in db/queries/music-rater.ts.
 */
describe('getMusicRaterFilterOptions (real db)', () => {
  let db: Database
  let close: () => Promise<void>

  beforeEach(async () => {
    const testDb = await makeTestDb()
    db = testDb.db as unknown as Database
    close = testDb.close
  })

  afterEach(async () => {
    await close()
  })

  it('offers only values present in that user’s corpus', async () => {
    const [user1] = await db
      .insert(users)
      .values({ username: 'filter-opts-1', passwordHash: 'x' })
      .returning({ id: users.id })
    const [user2] = await db
      .insert(users)
      .values({ username: 'filter-opts-2', passwordHash: 'x' })
      .returning({ id: users.id })
    if (!user1 || !user2) throw new Error('test users were not created')

    await upsertMusicRaterAlbums(db, user1.id, [
      row({ musicRaterAlbumId: 1, genreSlugs: ['doom-metal'], coverageTypes: ['tymhm'] }),
    ])
    await upsertMusicRaterAlbums(db, user2.id, [
      row({ musicRaterAlbumId: 1, genreSlugs: ['power-metal'], coverageTypes: ['aoty'] }),
    ])

    const opts = await getMusicRaterFilterOptions(db, user1.id)
    expect(opts.genres).toEqual(['doom-metal'])
    expect(opts.coverageTypes).toEqual(['tymhm'])
  })

  it('returns distinct values sorted alphabetically', async () => {
    const [user] = await db
      .insert(users)
      .values({ username: 'filter-opts-sort', passwordHash: 'x' })
      .returning({ id: users.id })
    if (!user) throw new Error('test user was not created')

    await upsertMusicRaterAlbums(db, user.id, [
      row({ musicRaterAlbumId: 1, genreSlugs: ['doom-metal', 'black-metal'] }),
      row({ musicRaterAlbumId: 2, genreSlugs: ['black-metal'] }),
    ])
    expect((await getMusicRaterFilterOptions(db, user.id)).genres).toEqual([
      'black-metal',
      'doom-metal',
    ])
  })

  it('returns empty lists for a user with no synced corpus', async () => {
    const [user] = await db
      .insert(users)
      .values({ username: 'filter-opts-empty', passwordHash: 'x' })
      .returning({ id: users.id })
    if (!user) throw new Error('test user was not created')

    const opts = await getMusicRaterFilterOptions(db, user.id)
    expect(opts).toEqual({ genres: [], coverageTypes: [] })
  })

  it('still reports a stored "unknown" coverage type -- this is a corpus inventory, not a UI filter', async () => {
    // The resolver in critically-acclaimed.ts is responsible for hiding
    // "unknown" from the picker (see its own docstring for why); this query
    // must not do that filtering itself, or the mode-level suppression would
    // have nothing real to suppress and a test asserting it would be vacuous.
    const [user] = await db
      .insert(users)
      .values({ username: 'filter-opts-unknown', passwordHash: 'x' })
      .returning({ id: users.id })
    if (!user) throw new Error('test user was not created')

    await upsertMusicRaterAlbums(db, user.id, [
      row({ musicRaterAlbumId: 1, coverageTypes: ['unknown'] }),
    ])
    expect((await getMusicRaterFilterOptions(db, user.id)).coverageTypes).toEqual(['unknown'])
  })
})
