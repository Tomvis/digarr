/**
 * Name normalisation for cross-source joins (music-rater ↔ digarr).
 *
 * The music-rater corpus join applies the SAME normalisation to both sides of
 * the comparison. Two sources' own normalisations never have to agree if digarr
 * normalises both itself, but that only holds while there is exactly one digarr
 * normaliser per join.
 *
 * This module is NEW CODE for music-rater integration. DO NOT refactor existing
 * call sites to use it:
 *
 * - `normalizeTitle` in `albums/popular.ts` is deliberately aggressive: it
 *   replaces `&` with `and` and strips everything but [a-z0-9], folding
 *   "Sgt. Pepper's" to "sgt pepper s". This is correct for its use case
 *   (Spotify ↔ MusicBrainz title matching).
 *
 * - `artistKey` in `pipeline/genre-backfill.ts` is deliberately minimal:
 *   just `name.trim().toLowerCase()`, with NO diacritic stripping. It keys a
 *   persisted cache table. Changing the key formula silently orphans all rows
 *   written under the old spelling — the code cannot tell "cache miss" from
 *   "cache key changed underneath me". That is the same class of failure the
 *   architecture notes warn about. Do not "tidy" this without understanding
 *   the migration cost.
 *
 * NOT the same thing as `normalizeTitle` in `pipeline/resolve.ts`, which
 * strips a trailing parenthetical to match MusicBrainz release-group titles.
 * That is a disambiguation rule for one specific comparison, not a general
 * matching key, and folding it in here would change `matchSuggestedAlbum`.
 *
 * This is a deliberately conservative matching key: punctuation is NOT
 * stripped (a title differing only by punctuation will not match), and a
 * non-Latin script (Cyrillic, CJK, ...) passes through unchanged apart from
 * `.toLowerCase()` -- there is no transliteration. Worth stating explicitly
 * now that this module has a real consumer (the music-rater join): both
 * properties bound what it will and won't match.
 */

/** Ligatures NFKD leaves intact, which would otherwise split a match. */
const LIGATURES: ReadonlyArray<readonly [RegExp, string]> = [
  [/æ/g, 'ae'],
  [/œ/g, 'oe'],
  [/ø/g, 'o'],
  [/ß/g, 'ss'],
  [/đ/g, 'd'],
  [/ł/g, 'l'],
]

function baseNormalize(value: string): string {
  let out = value.normalize('NFKD').toLowerCase()
  for (const [pattern, replacement] of LIGATURES) out = out.replace(pattern, replacement)
  return out
    .replace(/[̀-ͯ]/g, '') // combining marks left by NFKD
    .replace(/\s+/g, ' ')
    .trim()
}

/** Matching key for an artist name. */
export function normalizeArtistName(name: string): string {
  return baseNormalize(name)
}

/** Matching key for an album title. */
export function normalizeAlbumTitle(title: string): string {
  return baseNormalize(title)
}
