import { and, asc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm'
import { normalizeAlbumTitle, normalizeArtistName } from '@/core/matching/normalize'
import type { MusicRaterAlbumRow } from '@/core/music-rater/sync'
import type { Database } from '@/db'
import { libraryAlbums, libraryArtists, musicRaterAlbums } from '@/db/schema'

/**
 * A repeatedly-failing resolution (e.g. an artist name that 400s MusicBrainz's
 * Lucene search deterministically, forever -- `[dunkelbunt]`, `!!!`) must not
 * retry forever: it would sit at the head of `resolvedAt asc nulls first`
 * every single run, burning the whole slice on the same poison rows. A
 * transient failure gets a few free retries; the Nth CUMULATIVE one is
 * stamped (with null mbids, exactly like an unmatchable album) so it rotates
 * out of the "never attempted" bucket instead of monopolising it forever.
 * "Cumulative", not "consecutive": `resolutionAttempts` is a running total
 * across this row's whole retry history and is never reset -- not by a
 * non-throwing miss, not by anything else. Nothing decrements it.
 */
const MAX_RESOLUTION_ATTEMPTS = 3

/**
 * Upsert one synced page.
 *
 * The excluded-column list is the important part: a resync must NOT clear
 * `resolved_*`. Those columns are the cached result of one MusicBrainz
 * artist search plus one release-group listing per album, through a gate
 * that allows 360 requests an hour. Overwriting them on every nightly sync
 * would make the discovery mode re-resolve the whole corpus forever and
 * never advance past the first slice.
 */
export async function upsertMusicRaterAlbums(
  db: Database,
  userId: number,
  rows: MusicRaterAlbumRow[],
): Promise<void> {
  if (rows.length === 0) return
  await db
    .insert(musicRaterAlbums)
    .values(rows.map((row) => ({ ...row, userId })))
    .onConflictDoUpdate({
      target: [musicRaterAlbums.userId, musicRaterAlbums.musicRaterAlbumId],
      set: {
        artistNameRaw: sql`excluded.artist_name_raw`,
        albumTitleRaw: sql`excluded.album_title_raw`,
        artistNameNormalized: sql`excluded.artist_name_normalized`,
        albumTitleNormalized: sql`excluded.album_title_normalized`,
        releaseYear: sql`excluded.release_year`,
        maxScoreRatio: sql`excluded.max_score_ratio`,
        drValue: sql`excluded.dr_value`,
        genreSlugs: sql`excluded.genre_slugs`,
        sourceSites: sql`excluded.source_sites`,
        coverageTypes: sql`excluded.coverage_types`,
        syncedAt: sql`now()`,
      },
    })
}

/**
 * The distinct genre slugs and coverage types present in this user's synced
 * corpus, for the mode's option pickers.
 *
 * Deliberately corpus-derived rather than fetched from music-rater: digarr
 * then carries no copy of music-rater's taxonomy that can drift, and the
 * options come from this user's own corpus rather than a hardcoded or remote
 * list -- their corpus is already narrowed by their followed sites. This is
 * NOT a guarantee that every offered value returns a non-empty result: it
 * ignores `resolved_release_group_mbid`, the ownership `NOT EXISTS`,
 * `minReleaseYear` and the score gate that `getUnresolvedAcclaimedAlbums`
 * itself applies, so e.g. a user whose only `doom-metal` album is already
 * resolved is still offered "Doom Metal" and gets nothing.
 *
 * Returns every distinct value stored, `unknown` coverage type included --
 * this is a corpus inventory, not a UI-ready option list. It is the CALLER
 * (`critically-acclaimed.ts`'s `resolveOptions`) that suppresses `unknown`
 * from what gets offered, since that is a presentation decision, not a fact
 * about the corpus.
 */
export async function getMusicRaterFilterOptions(
  db: Database,
  userId: number,
): Promise<{ genres: string[]; coverageTypes: string[] }> {
  const result = await db.execute<{ genres: string[]; coverage_types: string[] }>(sql`
    SELECT
      (SELECT coalesce(array_agg(DISTINCT g ORDER BY g), '{}')
         FROM ${musicRaterAlbums} a2, jsonb_array_elements_text(a2.genre_slugs) g
        WHERE a2.user_id = ${userId}) AS genres,
      (SELECT coalesce(array_agg(DISTINCT c ORDER BY c), '{}')
         FROM ${musicRaterAlbums} a3, jsonb_array_elements_text(a3.coverage_types) c
        WHERE a3.user_id = ${userId}) AS coverage_types
  `)
  const first = result.rows[0]
  return { genres: first?.genres ?? [], coverageTypes: first?.coverage_types ?? [] }
}

export type AcclaimedAlbumRow = {
  id: number
  artistNameRaw: string
  albumTitleRaw: string
  releaseYear: number | null
}

/**
 * Normalised (artist, title) pairs, as two parallel arrays, for every album
 * this user (or the global/null-owner library, same scoping as
 * `listOwnedAlbumsForArtist`) already owns.
 *
 * Deliberately does NOT read `library_albums.title_normalized` /
 * `library_artists.name_normalized`: those columns are produced by
 * `src/core/library/normalize.ts`, a DIFFERENT normaliser from
 * `src/core/matching/normalize.ts` (this join's normaliser, and the one
 * `music_rater_albums.artist_name_normalized` / `album_title_normalized`
 * are already stored with). The two disagree on real inputs -- e.g.
 * `src/core/library/normalize.ts` strips "(Deluxe Edition)"-style
 * parentheticals and leading "The "; `src/core/matching/normalize.ts` does
 * neither. Comparing one side's library-normaliser output against the
 * other's matching-normaliser output would silently under-match (owned
 * albums slipping through as "new"), so both sides of this comparison are
 * (re)computed here, from the raw names, with the same function.
 *
 * Returned as two parallel arrays (not a `Set<"artist::title">`) so the
 * caller can hand them to Postgres as exactly two bind parameters via
 * `unnest(...)`, whatever the library size -- see
 * `getUnresolvedAcclaimedAlbums`.
 */
async function getOwnedAlbumNormalizedKeyPairs(
  db: Database,
  userId: number,
): Promise<{ artists: string[]; titles: string[] }> {
  const rows = await db
    .select({ artistName: libraryArtists.name, title: libraryAlbums.title })
    .from(libraryAlbums)
    .innerJoin(libraryArtists, eq(libraryAlbums.artistMbid, libraryArtists.mbid))
    .where(
      and(
        // biome-ignore lint/style/noNonNullAssertion: or() with two non-null args always returns SQL, never undefined
        or(eq(libraryAlbums.userId, userId), isNull(libraryAlbums.userId))!,
        // biome-ignore lint/style/noNonNullAssertion: or() with two non-null args always returns SQL, never undefined
        or(eq(libraryArtists.userId, userId), isNull(libraryArtists.userId))!,
      ),
    )
  return {
    artists: rows.map((row) => normalizeArtistName(row.artistName)),
    titles: rows.map((row) => normalizeAlbumTitle(row.title)),
  }
}

/**
 * The next slice of unowned, highly rated albums to resolve.
 *
 * `resolvedAt asc nulls first` is the rotation: never-attempted rows go
 * first, then the least recently attempted. Rows that already carry a
 * release-group MBID are excluded outright — they are done.
 *
 * Ownership is filtered HERE, before any MusicBrainz call is spent: a
 * name-based match (both sides normalised with `src/core/matching/normalize.ts`,
 * see `getOwnedAlbumNormalizedKeyPairs`) against the album this row's `resolvedAt`
 * position would otherwise waste a search+lookup pair resolving. This is a
 * cheap, best-effort pass, not the definitive check -- a corpus row whose
 * artist/title spelling differs from the library's (a real MusicBrainz-side
 * name variant, an alias, a retitled reissue) will still pass through here.
 * The definitive check is post-resolution, by exact release-group MBID (see
 * `isReleaseGroupOwnedByUser`), once this row actually has one to check.
 *
 * The ownership filter is a `NOT EXISTS` against `unnest(...)` of the two
 * owned-key arrays, not a `notInArray` of composite `"artist::title"`
 * strings (the previous approach). Two things wrong with that: (1)
 * `notInArray` binds one Postgres parameter PER owned album, and a 17k-album
 * library blows well past Postgres's 65535-parameter cap; (2) comparing a
 * concatenated `artist || '::' || title` expression can't use
 * `music_rater_albums_name_match_idx` (an index on the two separate
 * columns), so it always required a full scan of this user's corpus. The
 * `unnest` form sends exactly two array parameters regardless of library
 * size, and compares the two RAW columns directly, so the planner can hash
 * or index its way through the anti-join instead of evaluating a computed
 * expression per row.
 */
export async function getUnresolvedAcclaimedAlbums(
  db: Database,
  userId: number,
  opts: {
    minScoreRatio: number
    minReleaseYear: number
    limit: number
    /** Empty (the default) adds no SQL at all -- no constraint. */
    includeGenres?: string[]
    /** Empty (the default) adds no SQL at all -- no constraint. */
    excludeGenres?: string[]
    /** Empty (the default) adds no SQL at all -- no constraint. */
    coverageTypes?: string[]
    /**
     * An unscored album is what the editorial columns (tymhm/sitf/ymio/lit)
     * produce -- they carry no rating at all. Off by default so a corpus
     * that grows to include them does not change what existing runs return.
     */
    includeUnscored?: boolean
  },
): Promise<AcclaimedAlbumRow[]> {
  const owned = await getOwnedAlbumNormalizedKeyPairs(db, userId)
  const notOwned = sql`NOT EXISTS (
    SELECT 1 FROM unnest(${sql.param(owned.artists)}::text[], ${sql.param(owned.titles)}::text[])
      AS owned_lib(artist_norm, title_norm)
    WHERE owned_lib.artist_norm = ${musicRaterAlbums.artistNameNormalized}
      AND owned_lib.title_norm = ${musicRaterAlbums.albumTitleNormalized}
  )`

  const includeGenres = opts.includeGenres ?? []
  const excludeGenres = opts.excludeGenres ?? []
  const coverageTypes = opts.coverageTypes ?? []
  const includeUnscored = opts.includeUnscored ?? false

  const filters = [
    eq(musicRaterAlbums.userId, userId),
    isNull(musicRaterAlbums.resolvedReleaseGroupMbid),
    gte(musicRaterAlbums.releaseYear, opts.minReleaseYear),
    notOwned,
  ]

  filters.push(
    includeUnscored
      ? sql`(${musicRaterAlbums.maxScoreRatio} >= ${opts.minScoreRatio} OR ${musicRaterAlbums.maxScoreRatio} IS NULL)`
      : gte(musicRaterAlbums.maxScoreRatio, opts.minScoreRatio),
  )

  // `?|` matches any element of the stored JSON array against a text[]
  // passed as ONE bound parameter -- never one parameter per value (see this
  // file's `notOwned` docstring for why that matters at corpus scale).
  // Exclude wins over include because both predicates are ANDed: an album
  // matching both the include and exclude sets is dropped by the NOT below.
  if (includeGenres.length > 0) {
    filters.push(sql`${musicRaterAlbums.genreSlugs} ?| ${sql.param(includeGenres)}::text[]`)
  }
  if (excludeGenres.length > 0) {
    // `coalesce` matters here: `NOT (NULL::jsonb ?| ARRAY[...])` evaluates to
    // SQL NULL, not TRUE, so an un-coalesced predicate would silently DROP a
    // row whose genre_slugs is NULL from an exclude filter's results -- a
    // "no genres recorded" row overlaps nothing and must survive. `toRow`
    // (core/music-rater/sync.ts) always writes `?? []`, so this column is
    // never actually NULL on a synced row today, but the sibling
    // `coverage_types` jsonb column IS NULL on every pre-existing row between
    // migration 0054 and that row's first post-deploy sync -- proof this
    // table really does carry NULL jsonb columns in production, not just in
    // theory -- so this predicate is written defensively rather than relying
    // on `toRow` never changing.
    filters.push(
      sql`NOT (coalesce(${musicRaterAlbums.genreSlugs}, '[]'::jsonb) ?| ${sql.param(excludeGenres)}::text[])`,
    )
  }
  if (coverageTypes.length > 0) {
    filters.push(sql`${musicRaterAlbums.coverageTypes} ?| ${sql.param(coverageTypes)}::text[]`)
  }

  return db
    .select({
      id: musicRaterAlbums.id,
      artistNameRaw: musicRaterAlbums.artistNameRaw,
      albumTitleRaw: musicRaterAlbums.albumTitleRaw,
      releaseYear: musicRaterAlbums.releaseYear,
    })
    .from(musicRaterAlbums)
    .where(and(...filters))
    .orderBy(sql`${musicRaterAlbums.resolvedAt} asc nulls first`, asc(musicRaterAlbums.id))
    .limit(opts.limit)
}

/**
 * The definitive ownership check: does this user (or the global/null-owner
 * library) already have an album with exactly this release-group MBID.
 *
 * Unlike the pre-resolution name filter, this cannot false-negative on a
 * spelling difference -- it is the same MBID space `library_albums.album_mbid`
 * is populated from (`src/core/library/album-reconciler.ts`'s
 * `getReleaseGroups` lookups) and the same one `matchSuggestedAlbum` returns
 * here. Called once a corpus row has actually resolved to a release group.
 */
export async function isReleaseGroupOwnedByUser(
  db: Database,
  userId: number,
  releaseGroupMbid: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: libraryAlbums.id })
    .from(libraryAlbums)
    .where(
      and(
        eq(libraryAlbums.albumMbid, releaseGroupMbid),
        // biome-ignore lint/style/noNonNullAssertion: or() with two non-null args always returns SQL, never undefined
        or(eq(libraryAlbums.userId, userId), isNull(libraryAlbums.userId))!,
      ),
    )
    .limit(1)
  return rows.length > 0
}

/**
 * Record a failed resolution attempt (the MusicBrainz call threw). Increments
 * the cumulative-failure counter and, once it reaches `MAX_RESOLUTION_ATTEMPTS`,
 * stamps `resolvedAt` (with null mbids, same shape as an unmatchable album) so
 * the row rotates out of the "never attempted" head of the cursor instead of
 * being retried on every single run forever. Below the threshold, `resolvedAt`
 * is left untouched (still null, if it was) so the row is retried next run --
 * transient MusicBrainz failures must keep retrying.
 */
export async function recordMusicRaterResolutionFailure(db: Database, id: number): Promise<void> {
  await db
    .update(musicRaterAlbums)
    .set({
      resolutionAttempts: sql`${musicRaterAlbums.resolutionAttempts} + 1`,
      resolvedAt: sql`CASE WHEN ${musicRaterAlbums.resolutionAttempts} + 1 >= ${MAX_RESOLUTION_ATTEMPTS} THEN now() ELSE ${musicRaterAlbums.resolvedAt} END`,
    })
    .where(eq(musicRaterAlbums.id, id))
}

/**
 * Record a resolution attempt. ALWAYS stamps `resolvedAt`, including on a
 * miss — an album that cannot be matched must still leave the head of the
 * cursor, or every subsequent run re-attempts the same dead rows.
 */
export async function markMusicRaterAlbumResolved(
  db: Database,
  id: number,
  resolved: { artistMbid: string | null; releaseGroupMbid: string | null },
): Promise<void> {
  await db
    .update(musicRaterAlbums)
    .set({
      resolvedArtistMbid: resolved.artistMbid,
      resolvedReleaseGroupMbid: resolved.releaseGroupMbid,
      resolvedAt: new Date(),
    })
    .where(eq(musicRaterAlbums.id, id))
}

export type CriticScoreKey = { artistNormalized: string; titleNormalized: string }

/**
 * Critic ratings for a batch of (artist, title) pairs, keyed
 * `"<artist>::<title>"`. One query per scan, not one per candidate.
 *
 * The two `inArray`s are a deliberate over-fetch: they match the
 * cross-product of the requested artists and titles, then the `Map` keyed on
 * the exact pair discards the rest. A row-wise `IN ((a,b),(c,d))` would be
 * tighter, but this keeps the query trivially parameterised and the slice is
 * at most a scan's worth of candidates.
 */
export async function findMusicRaterScoresByNames(
  db: Database,
  userId: number,
  keys: CriticScoreKey[],
): Promise<Map<string, number>> {
  if (keys.length === 0) return new Map()
  const rows = await db
    .select({
      artistNameNormalized: musicRaterAlbums.artistNameNormalized,
      albumTitleNormalized: musicRaterAlbums.albumTitleNormalized,
      maxScoreRatio: musicRaterAlbums.maxScoreRatio,
    })
    .from(musicRaterAlbums)
    .where(
      and(
        eq(musicRaterAlbums.userId, userId),
        inArray(
          musicRaterAlbums.artistNameNormalized,
          keys.map((k) => k.artistNormalized),
        ),
        inArray(
          musicRaterAlbums.albumTitleNormalized,
          keys.map((k) => k.titleNormalized),
        ),
      ),
    )

  const out = new Map<string, number>()
  for (const row of rows) {
    if (row.maxScoreRatio === null) continue
    out.set(`${row.artistNameNormalized}::${row.albumTitleNormalized}`, row.maxScoreRatio)
  }
  return out
}
