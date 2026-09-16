import PQueue from 'p-queue'
import type { DiscoveryModeDefinition, RawDiscoveryCandidate } from '../types'

const DEFAULT_MAX_ALBUMS_PER_RUN = 25
const DEFAULT_MIN_SCORE_RATIO = 0.8
const DEFAULT_MIN_RELEASE_YEAR = 2000

export type AcclaimedAlbum = {
  id: number
  artistNameRaw: string
  albumTitleRaw: string
  releaseYear: number | null
}

export type CriticallyAcclaimedDeps = {
  getUnresolvedAcclaimedAlbums: (
    userId: number,
    opts: { minScoreRatio: number; minReleaseYear: number; limit: number },
  ) => Promise<AcclaimedAlbum[]>
  resolveArtistMbid: (artistName: string) => Promise<string | null>
  matchAlbum: (
    title: string,
    artistMbid: string,
  ) => Promise<{ releaseGroupId?: string; title: string; firstReleaseDate?: string }>
  markResolved: (
    id: number,
    resolved: { artistMbid: string | null; releaseGroupMbid: string | null },
  ) => Promise<void>
}

async function defaultDeps(): Promise<CriticallyAcclaimedDeps> {
  const [{ db }, queries, { createMusicBrainzClient }, { matchSuggestedAlbum }] = await Promise.all(
    [
      import('@/db'),
      import('@/db/queries/music-rater'),
      import('@/core/clients/musicbrainz'),
      import('@/core/pipeline/resolve'),
    ],
  )
  const mb = createMusicBrainzClient()
  return {
    getUnresolvedAcclaimedAlbums: (userId, opts) =>
      queries.getUnresolvedAcclaimedAlbums(db, userId, opts),
    resolveArtistMbid: async (artistName) => {
      // `searchArtist` returns MBSearchResult = { artists: [...] }, ordered by
      // MusicBrainz's own relevance score. Taking the top hit is deliberate
      // and self-correcting: if it is the wrong artist, `matchSuggestedAlbum`
      // will not find the album among that artist's release groups and the
      // row resolves to no candidate. The pipeline's own resolve stage does
      // the heavier genre-overlap disambiguation (`resolve.ts:141-160`)
      // because it has only an artist name to go on; here the album title is
      // a second constraint that rejects a bad match for free.
      const result = await mb.searchArtist(artistName)
      return result.artists[0]?.id ?? null
    },
    matchAlbum: (title, artistMbid) => matchSuggestedAlbum(title, artistMbid, mb),
    markResolved: (id, resolved) => queries.markMusicRaterAlbumResolved(db, id, resolved),
  }
}

function numberSetting(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Turn music-rater's critically acclaimed albums the user does not own into
 * first-class album candidates.
 *
 * music-rater only carries a release-group MBID for albums that went through
 * Lidarr sync -- i.e. albums already owned -- so every row this mode is
 * interested in arrives with no MBID at all and has to be resolved here.
 * That resolution is the expensive part (one MusicBrainz artist search plus
 * one release-group listing per album, through the shared rate gate), which
 * is why the slice is bounded and why the result is written back: an album
 * is resolved against MusicBrainz exactly once, ever, and the cursor
 * (`resolvedAt`, ascending nulls first) guarantees the next run moves on.
 *
 * An album that cannot be resolved is stamped anyway. Leaving it unstamped
 * would put it at the head of the cursor forever and every subsequent run
 * would re-attempt the same permanently unmatchable rows, starving the rest
 * of the corpus.
 */
export function createCriticallyAcclaimedMode(
  injected?: CriticallyAcclaimedDeps,
): DiscoveryModeDefinition {
  return {
    id: 'critically-acclaimed',
    label: 'Critically Acclaimed',
    description: 'Highly rated albums from your review sources that you do not own yet',
    availability: 'strict',
    easyFields: [
      { key: 'minScoreRatio', label: 'Minimum score (0-1)', type: 'number' },
      { key: 'minReleaseYear', label: 'Released since', type: 'number' },
    ],
    advancedFields: [{ key: 'maxAlbumsPerRun', label: 'Albums resolved per run', type: 'number' }],
    executor: async (request) => {
      const deps = injected ?? (await defaultDeps())
      const settings = request.normalizedSettings

      const albums = await deps.getUnresolvedAcclaimedAlbums(request.userId, {
        minScoreRatio: numberSetting(settings.minScoreRatio, DEFAULT_MIN_SCORE_RATIO),
        minReleaseYear: numberSetting(settings.minReleaseYear, DEFAULT_MIN_RELEASE_YEAR),
        limit: numberSetting(settings.maxAlbumsPerRun, DEFAULT_MAX_ALBUMS_PER_RUN),
      })
      if (albums.length === 0) return { candidates: [] }

      // Same shape as gap-fill: two live MusicBrainz calls per album would
      // otherwise starve the event loop and trip the k8s liveness probe.
      const queue = new PQueue({ concurrency: 2, interval: 200, intervalCap: 2 })

      const perAlbum = await Promise.all(
        albums.map((album) =>
          queue.add(async (): Promise<RawDiscoveryCandidate[]> => {
            try {
              const artistMbid = await deps.resolveArtistMbid(album.artistNameRaw)
              if (artistMbid === null) {
                await deps.markResolved(album.id, {
                  artistMbid: null,
                  releaseGroupMbid: null,
                })
                return []
              }

              const matched = await deps.matchAlbum(album.albumTitleRaw, artistMbid)
              await deps.markResolved(album.id, {
                artistMbid,
                releaseGroupMbid: matched.releaseGroupId ?? null,
              })
              if (!matched.releaseGroupId) return []

              return [
                {
                  candidateType: 'release' as const,
                  name: album.albumTitleRaw,
                  artistName: album.artistNameRaw,
                  artistMbid,
                  releaseGroupMbid: matched.releaseGroupId,
                  provenanceProvider: 'music-rater',
                  fallbackUsed: false,
                  ...(album.releaseYear != null
                    ? { freshnessDate: String(album.releaseYear) }
                    : {}),
                },
              ]
            } catch {
              // One album's MusicBrainz failure must not lose the slice's
              // other resolutions. Deliberately NOT stamped: this is a
              // transient failure, not an unmatchable album, so it should be
              // retried on the next run.
              return []
            }
          }),
        ),
      )

      return {
        candidates: perAlbum
          .filter((entry): entry is RawDiscoveryCandidate[] => Array.isArray(entry))
          .flat(),
      }
    },
  }
}
