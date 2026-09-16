/**
 * Name normalisation for matching records across sources.
 *
 * Extracted from two private copies -- `artistKey` in
 * `pipeline/genre-backfill.ts` and `normalizeTitle` in `albums/popular.ts` --
 * because a third consumer (the music-rater corpus join) has to apply the
 * SAME function to both sides of a comparison. Two sources' own
 * normalisations never have to agree if digarr normalises both itself, but
 * that only holds while there is exactly one digarr normaliser.
 *
 * NOT the same thing as `normalizeTitle` in `pipeline/resolve.ts`, which
 * strips a trailing parenthetical to match MusicBrainz release-group titles.
 * That is a disambiguation rule for one specific comparison, not a general
 * matching key, and folding it in here would change `matchSuggestedAlbum`.
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
