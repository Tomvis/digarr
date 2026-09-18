import PQueue from 'p-queue'
// `AcclaimedAlbumRow` is the row shape `getUnresolvedAcclaimedAlbums` (the DB
// layer) actually returns. This module used to declare its own structurally
// identical `AcclaimedAlbum` type one file away in the same dependency
// chain; collapsed onto the query's own type instead of keeping two names
// for one shape. `import type` is erased at compile time, so this does not
// pull `db/queries/music-rater` (and therefore the DB) into this module's
// runtime graph -- `defaultDeps` below still loads it lazily via `import()`.
import type { AcclaimedAlbumRow } from '@/db/queries/music-rater'
import type { DiscoveryModeDefinition, RawDiscoveryCandidate } from '../types'

const DEFAULT_MAX_ALBUMS_PER_RUN = 25
const DEFAULT_MIN_SCORE_RATIO = 0.8
const DEFAULT_MIN_RELEASE_YEAR = 2000

export type CriticallyAcclaimedDeps = {
  getUnresolvedAcclaimedAlbums: (
    userId: number,
    opts: {
      minScoreRatio: number
      minReleaseYear: number
      limit: number
      includeGenres: string[]
      excludeGenres: string[]
      coverageTypes: string[]
      includeUnscored: boolean
    },
  ) => Promise<AcclaimedAlbumRow[]>
  resolveArtistMbid: (artistName: string) => Promise<string | null>
  matchAlbum: (
    title: string,
    artistMbid: string,
  ) => Promise<{ releaseGroupId?: string; title: string; firstReleaseDate?: string }>
  markResolved: (
    id: number,
    resolved: { artistMbid: string | null; releaseGroupMbid: string | null },
  ) => Promise<void>
  /**
   * Definitive ownership check by exact release-group MBID, against digarr's
   * own library (never music-rater's `lidarr_synced` -- that reflects
   * music-rater's Lidarr view, not digarr's). Called once a row has actually
   * resolved to a release group; `getUnresolvedAcclaimedAlbums` already did a
   * cheaper, best-effort name-based pass before spending any MusicBrainz
   * budget, but this is the check that must never miss.
   */
  isAlbumOwned: (userId: number, releaseGroupMbid: string) => Promise<boolean>
  /**
   * Records a thrown (not merely unmatched) resolution attempt, so a
   * deterministically-failing row (see MAX_RESOLUTION_ATTEMPTS in
   * db/queries/music-rater.ts) eventually leaves the head of the cursor
   * instead of being retried on every run forever.
   */
  recordResolutionFailure: (id: number) => Promise<void>
  /**
   * The distinct genre slugs and coverage types in this user's synced
   * corpus, feeding `resolveOptions` below. Required, not optional, like
   * every other dep here -- see this file's test suite baseDeps() comment
   * for why a missing wiring should be a compile error, not a silent
   * `undefined` swallowed somewhere at runtime. `resolveOptions` on the mode
   * definition is itself optional and the route degrades to empty options
   * when it throws (see DiscoveryModeDefinition), so this dep being required
   * does not make it load-bearing for the mode's core executor.
   */
  getFilterOptions: (userId: number) => Promise<{ genres: string[]; coverageTypes: string[] }>
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
    getFilterOptions: (userId) => queries.getMusicRaterFilterOptions(db, userId),
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
    isAlbumOwned: (userId, releaseGroupMbid) =>
      queries.isReleaseGroupOwnedByUser(db, userId, releaseGroupMbid),
    recordResolutionFailure: (id) => queries.recordMusicRaterResolutionFailure(db, id),
  }
}

function numberSetting(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Multiselect fields without options (see `discovery-mode-form.tsx`) render
 * as a free-text, comma-separated input, but the executor may also be
 * called directly (tests, subscriptions replaying stored settings) with an
 * actual `string[]`. Accept both, same shape as `parseRelationshipTypes` in
 * `artist-relationships.ts`.
 */
function listSetting(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  return items
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
}

/** `death-metal` -> `Death Metal`. A pure transform, so there is no genre
 *  taxonomy to keep in sync and no i18n key per genre. */
function genreLabel(slug: string): string {
  return slug
    .split('-')
    .map((part) => {
      const first = part.charAt(0)
      return first ? first.toUpperCase() + part.slice(1) : part
    })
    .join(' ')
}

/**
 * Coverage types get real names via i18n, unlike genres -- there are only a
 * handful of these (one per music-rater `post_type`) and they are proper
 * names (AMG/TPS series titles), not slugs a mechanical title-case would
 * render sensibly ("Tymhm" is not "TYMHM"; "Sitf" is not "Stuck in the
 * Filter"). Notably, two of this map's expansions are NOT what a
 * plausible-sounding guess from the acronym would produce: `sitf` is AMG's
 * "Stuck in the Filter" per music-rater's `parser/sitf.py` module docstring,
 * and `rfu` is TPS's "Reports from the (progressive metal) Underground" per
 * `parser/tps_rfu.py`'s module docstring (not e.g. "Sophomore in the
 * Foreground" or "Records for Us" -- plausible-sounding guesses from the
 * acronyms alone that are simply wrong).
 *
 * An UNKNOWN slug (one with no entry here) falls through to itself rather
 * than disappearing: if music-rater ever adds a post type, it still appears
 * in the picker and still filters -- just unprettified, until this map is
 * updated. `translateDiscoveryOption` (web/lib/discovery-i18n.ts) treats a
 * label starting with `discoveryMode.` as a message key and falls back to
 * the raw value, so returning the key directly here is the established
 * idiom -- see that function's own docstring.
 */
const COVERAGE_TYPE_LABELS: Record<string, string> = {
  review: 'discoveryMode.option.coverageReview',
  tymhm: 'discoveryMode.option.coverageTymhm',
  aoty: 'discoveryMode.option.coverageAoty',
  aotm: 'discoveryMode.option.coverageAotm',
  sitf: 'discoveryMode.option.coverageSitf',
  ymio: 'discoveryMode.option.coverageYmio',
  lit: 'discoveryMode.option.coverageLit',
  contrite: 'discoveryMode.option.coverageContrite',
  rfu: 'discoveryMode.option.coverageRfu',
}

function coverageLabel(slug: string): string {
  return COVERAGE_TYPE_LABELS[slug] ?? slug
}

/**
 * Every message key `COVERAGE_TYPE_LABELS` can produce, exported for i18n
 * liveness checks that sweep the mode registry's STATIC `field.options`
 * (`discovery-i18n.test.ts`'s registry-driven key test; `i18n-check.ts`'s
 * orphan-key sweep already finds these by literal string search instead).
 * This mode's real coverage-type options exist only per-user, minted by
 * `resolveOptions` at request time -- a static sweep of `easyFields` /
 * `advancedFields` (whose `coverageTypes` field declares no `options` of its
 * own) can never reach them on its own, so they need to be handed over
 * explicitly.
 */
export const COVERAGE_TYPE_MESSAGE_KEYS: string[] = Object.values(COVERAGE_TYPE_LABELS)

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
 *
 * An album that DOES resolve but turns out to already be in the user's
 * library is also stamped (it is genuinely resolved -- the cursor should
 * move on) but emits no candidate: this mode promises albums the user does
 * not own yet, and `getUnresolvedAcclaimedAlbums` only screens out owned
 * albums it can catch by name before spending MusicBrainz budget on them.
 *
 * The ownership check runs BEFORE the row is stamped, deliberately: stamping
 * writes a real `resolvedReleaseGroupMbid`, which permanently excludes the
 * row from `getUnresolvedAcclaimedAlbums` (`isNull(resolvedReleaseGroupMbid)`)
 * -- so if the ownership check threw after the stamp, the row would be both
 * "done" forever and never have emitted (or even decided on) a candidate,
 * with nothing pointing at it. Checking first means a throw there is caught
 * like any other failure in this loop: the row stays unresolved and is
 * retried next run.
 */
export function createCriticallyAcclaimedMode(
  injected?: CriticallyAcclaimedDeps,
): DiscoveryModeDefinition {
  return {
    id: 'critically-acclaimed',
    label: 'Critically Acclaimed',
    description: 'Highly rated albums from your review sources that you do not own yet',
    // Gated on exactly one connection flag (hasMusicRater), same shape as
    // labels/charts/subsonic-starred -- all of which are 'fallback' to match
    // their SINGLE_FLAG_MODES fallbackUsed:true (availability.ts). This mode
    // was 'strict', disagreeing with its own fallbackUsed:true.
    availability: 'fallback',
    easyFields: [
      { key: 'minScoreRatio', label: 'Minimum score (0-1)', type: 'number' },
      { key: 'minReleaseYear', label: 'Released since', type: 'number' },
      { key: 'includeGenres', label: 'Only these genres', type: 'multiselect' },
      { key: 'excludeGenres', label: 'Never these genres', type: 'multiselect' },
      { key: 'coverageTypes', label: 'Only these kinds of coverage', type: 'multiselect' },
    ],
    // A superset of easyFields, repeating each easy key verbatim before
    // adding the advanced-only ones -- the same convention every other mode
    // with distinct easy/advanced sets already follows (artist-relationships,
    // labels, similar-artist-web, listenbrainz, release-radar). Advanced mode
    // renders `advancedFields` INSTEAD OF `easyFields` (see
    // discovery-mode-form.tsx's `getFields`), and a submission only carries
    // whichever set is current (`buildSubmission`'s `fields`), so a key
    // missing here is a key that can never reach the request payload from
    // Advanced -- exactly the bug this fixes: `includeGenres`, `excludeGenres`
    // and `coverageTypes` used to live in `easyFields` ONLY while
    // `includeUnscored` lived in `advancedFields` ONLY, so the two could never
    // be submitted together.
    advancedFields: [
      { key: 'minScoreRatio', label: 'Minimum score (0-1)', type: 'number' },
      { key: 'minReleaseYear', label: 'Released since', type: 'number' },
      { key: 'includeGenres', label: 'Only these genres', type: 'multiselect' },
      { key: 'excludeGenres', label: 'Never these genres', type: 'multiselect' },
      { key: 'coverageTypes', label: 'Only these kinds of coverage', type: 'multiselect' },
      { key: 'maxAlbumsPerRun', label: 'Albums resolved per run', type: 'number' },
      { key: 'includeUnscored', label: 'Include unscored recommendations', type: 'toggle' },
    ],
    executor: async (request) => {
      const deps = injected ?? (await defaultDeps())
      const settings = request.normalizedSettings

      const albums = await deps.getUnresolvedAcclaimedAlbums(request.userId, {
        minScoreRatio: numberSetting(settings.minScoreRatio, DEFAULT_MIN_SCORE_RATIO),
        minReleaseYear: numberSetting(settings.minReleaseYear, DEFAULT_MIN_RELEASE_YEAR),
        limit: numberSetting(settings.maxAlbumsPerRun, DEFAULT_MAX_ALBUMS_PER_RUN),
        includeGenres: listSetting(settings.includeGenres),
        excludeGenres: listSetting(settings.excludeGenres),
        coverageTypes: listSetting(settings.coverageTypes),
        includeUnscored: settings.includeUnscored === true,
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
              const releaseGroupMbid = matched.releaseGroupId ?? null

              // Definitive ownership check, by exact release-group MBID
              // against digarr's own library. Deliberately run BEFORE
              // markResolved below -- see the module docstring's "runs
              // BEFORE the row is stamped" note. Only checked when there is
              // actually a release group to check.
              const owned =
                releaseGroupMbid !== null
                  ? await deps.isAlbumOwned(request.userId, releaseGroupMbid)
                  : false

              await deps.markResolved(album.id, { artistMbid, releaseGroupMbid })
              if (releaseGroupMbid === null || owned) return []

              return [
                {
                  candidateType: 'release' as const,
                  name: album.albumTitleRaw,
                  artistName: album.artistNameRaw,
                  artistMbid,
                  releaseGroupMbid,
                  provenanceProvider: 'music-rater',
                  fallbackUsed: false,
                  ...(album.releaseYear != null
                    ? { freshnessDate: String(album.releaseYear) }
                    : {}),
                },
              ]
            } catch {
              // One album's MusicBrainz failure must not lose the slice's
              // other resolutions. Deliberately NOT stamped directly here --
              // recordResolutionFailure only stamps once a bounded number of
              // CUMULATIVE attempts accumulate (it is a running total, never
              // reset by an intervening success -- see
              // db/queries/music-rater.ts's MAX_RESOLUTION_ATTEMPTS), so a
              // transient failure keeps retrying but a deterministically-failing
              // name (an unescaped Lucene-breaking artist name 400ing forever)
              // eventually leaves the head of the cursor too.
              try {
                await deps.recordResolutionFailure(album.id)
              } catch (recordErr) {
                // Bookkeeping must not be able to abort the whole slice's
                // Promise.all -- worst case this row is retried again next
                // run instead of rotating out, which is the same outcome as
                // any other transient failure below the attempt budget.
                console.error(
                  `[critically-acclaimed] recordResolutionFailure threw for album ${album.id}:`,
                  recordErr,
                )
              }
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
    resolveOptions: async (userId) => {
      const deps = injected ?? (await defaultDeps())
      const { genres, coverageTypes } = await deps.getFilterOptions(userId)
      const genreOptions = genres.map((g) => ({ value: g, label: genreLabel(g) }))
      return {
        includeGenres: genreOptions,
        excludeGenres: genreOptions,
        // `unknown` is a real, stored post_type -- music-rater's parser
        // assigns it on a decode/parse failure and reports it deliberately
        // so its API stays honest about the data; digarr keeps storing it
        // for the same reason (see getMusicRaterFilterOptions's docstring --
        // this query does NOT filter it out, on purpose). But "albums whose
        // coverage we failed to parse" is not a discovery intent anyone
        // would pick, so it is suppressed from the OFFERED options here --
        // a presentation decision, not a data one. Do not "fix" this by
        // filtering the sync or the column instead, and do not remove this
        // filter thinking it's redundant with the sync -- both directions
        // have been considered and rejected.
        coverageTypes: coverageTypes
          .filter((c) => c !== 'unknown')
          .map((c) => ({ value: c, label: coverageLabel(c) })),
      }
    },
  }
}
