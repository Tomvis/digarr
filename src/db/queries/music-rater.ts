import { and, asc, eq, gte, inArray, isNull, sql } from 'drizzle-orm'
import type { MusicRaterAlbumRow } from '@/core/music-rater/sync'
import type { Database } from '@/db'
import { musicRaterAlbums } from '@/db/schema'

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
        syncedAt: sql`now()`,
      },
    })
}

export type AcclaimedAlbumRow = {
  id: number
  artistNameRaw: string
  albumTitleRaw: string
  releaseYear: number | null
}

/**
 * The next slice of unowned, highly rated albums to resolve.
 *
 * `resolvedAt asc nulls first` is the rotation: never-attempted rows go
 * first, then the least recently attempted. Rows that already carry a
 * release-group MBID are excluded outright — they are done.
 */
export async function getUnresolvedAcclaimedAlbums(
  db: Database,
  userId: number,
  opts: { minScoreRatio: number; minReleaseYear: number; limit: number },
): Promise<AcclaimedAlbumRow[]> {
  return db
    .select({
      id: musicRaterAlbums.id,
      artistNameRaw: musicRaterAlbums.artistNameRaw,
      albumTitleRaw: musicRaterAlbums.albumTitleRaw,
      releaseYear: musicRaterAlbums.releaseYear,
    })
    .from(musicRaterAlbums)
    .where(
      and(
        eq(musicRaterAlbums.userId, userId),
        isNull(musicRaterAlbums.resolvedReleaseGroupMbid),
        gte(musicRaterAlbums.maxScoreRatio, opts.minScoreRatio),
        gte(musicRaterAlbums.releaseYear, opts.minReleaseYear),
      ),
    )
    .orderBy(sql`${musicRaterAlbums.resolvedAt} asc nulls first`, asc(musicRaterAlbums.id))
    .limit(opts.limit)
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
