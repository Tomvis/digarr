import type { MusicRaterAlbum, MusicRaterSiteScore } from '@/core/clients/music-rater'
import { normalizeAlbumTitle, normalizeArtistName } from '@/core/matching/normalize'

export type MusicRaterAlbumRow = {
  musicRaterAlbumId: number
  artistNameRaw: string
  albumTitleRaw: string
  artistNameNormalized: string
  albumTitleNormalized: string
  releaseYear: number | null
  maxScoreRatio: number | null
  drValue: number | null
  genreSlugs: string[]
  sourceSites: string[]
  coverageTypes: string[]
  siteScores?: MusicRaterSiteScore[]
}

export type MusicRaterSyncDeps = {
  client: {
    listAlbums(offset: number): Promise<{ items: MusicRaterAlbum[]; total: number }>
  }
  upsert(userId: number, rows: MusicRaterAlbumRow[]): Promise<void>
  /** Drop this user's rows whose music-rater album id is not in `keepIds`. */
  prune?(userId: number, keepIds: number[]): Promise<number>
}

function toRow(album: MusicRaterAlbum): MusicRaterAlbumRow {
  return {
    musicRaterAlbumId: album.id,
    artistNameRaw: album.artistName,
    albumTitleRaw: album.albumTitle,
    // Normalised HERE, with digarr's own functions, so that the score-signal
    // lookup compares two values produced by the same code. music-rater has
    // its own `artist_name_normalized`, deliberately not used: matching
    // against a normalisation this codebase does not control means a change
    // on either side silently stops matching, with no test that would catch it.
    artistNameNormalized: normalizeArtistName(album.artistName),
    albumTitleNormalized: normalizeAlbumTitle(album.albumTitle),
    releaseYear: album.releaseYear ?? null,
    maxScoreRatio: album.maxScoreRatio,
    drValue: album.drValue,
    genreSlugs: album.genreSlugs,
    sourceSites: album.sources,
    coverageTypes: album.coverageTypes,
    siteScores: album.siteScores,
  }
}

/**
 * Pull this user's music-rater corpus into `music_rater_albums`.
 *
 * Upserts page by page rather than accumulating and writing once: a 14k-row
 * corpus is small, but a mid-sync failure should leave the rows it already
 * got, not discard them. Resolution columns are never written here, so a
 * resync does not undo MusicBrainz work the discovery mode has already paid
 * for -- see the upsert's excluded-column list in `db/queries/music-rater.ts`.
 *
 * Errors propagate. A partial sync is visible in Job History as a failure,
 * and the previous corpus stays queryable, so a scan during an outage runs
 * against slightly stale data rather than nothing.
 *
 * Pagination tracks DISTINCT music-rater album ids seen, not a raw item
 * counter. `listAlbums` orders by `release_year desc` with no
 * tiebreaker (music-rater's `/api/v1/albums` has no sortable column that is
 * guaranteed unique -- see that client's own comment), so two rows tied on
 * `release_year` can legally be served in either order across adjacent
 * LIMIT/OFFSET pages; if the backend's tie order isn't perfectly stable
 * between calls, the same row can be returned twice while a different one
 * is skipped. A duplicate is harmless to `upsert` (it's a no-op re-write on
 * the natural key), but a raw counter would count it as progress, reach
 * `page.total` a page early, and stop before the tail of the corpus was
 * ever fetched -- silently shrinking the synced corpus with no error. A
 * distinct-id count can't be inflated by a duplicate, so it can't end the
 * loop early; the empty-page check above remains the actual backstop
 * against a bad or shrinking `total`.
 */
export async function syncMusicRaterCorpus(
  deps: MusicRaterSyncDeps,
  userId: number,
): Promise<{ synced: number; pruned: number }> {
  let offset = 0
  const seenIds = new Set<number>()
  let complete = false

  for (;;) {
    const page = await deps.client.listAlbums(offset)
    // An empty page terminates regardless of what `total` claims: trusting
    // `total` alone turns an off-by-one or a concurrent delete on the
    // music-rater side into an infinite request loop.
    if (page.items.length === 0) break

    await deps.upsert(userId, page.items.map(toRow))
    for (const item of page.items) seenIds.add(item.id)
    offset += page.items.length

    if (seenIds.size >= page.total) {
      complete = true
      break
    }
  }

  // music-rater DELETES album rows when it merges duplicates (re-key,
  // merge-duplicates), and the upsert alone never removes them, so a merged-
  // away album lived on here as a stale twin (26 found 2026-10-09, MUSIC-53).
  // Prune only after a COMPLETE pass: an empty-page stop may be a truncated
  // read, and pruning against it would drop live rows.
  let pruned = 0
  if (complete && deps.prune && seenIds.size > 0) {
    pruned = await deps.prune(userId, [...seenIds])
  }

  return { synced: seenIds.size, pruned }
}
