/**
 * Review sites music-rater scores, each on its own native scale. Mirrors
 * music-rater's `sources.REGISTRY` (label, score_scale, default_min_score);
 * a new scored site there needs one line here to get its own settings
 * section in the Critically Acclaimed mode.
 */
export type ReviewSite = {
  id: string
  label: string
  /** Native maximum (AMG rates /5, TPS /10). */
  scale: number
  /** Smallest score increment the site uses. */
  step: number
  /** Default bar, in native units (music-rater's `default_min_score`). */
  defaultMinScore: number
}

export const REVIEW_SITES: readonly ReviewSite[] = [
  { id: 'amg', label: 'Angry Metal Guy', scale: 5, step: 0.5, defaultMinScore: 4 },
  { id: 'tps', label: 'The Progressive Subway', scale: 10, step: 0.5, defaultMinScore: 8 },
]

/** One site's bar for the acclaimed-albums query, in that site's units. */
export type SiteFilter = {
  site: string
  minScore: number
  /** Let unscored coverage (TYMHM picks, year-end lists) through. */
  includeUnscored: boolean
  /** Empty = any coverage type from this site. */
  coverageTypes: string[]
}

/** `any`: one passing site is enough. `all`: every enabled site covering the album must pass. */
export type SiteMatch = 'any' | 'all'

/** Settings keys for one site's section, e.g. `amgMinScore`. */
export function siteSettingKeys(siteId: string) {
  return {
    enabled: `${siteId}Enabled`,
    minScore: `${siteId}MinScore`,
    includeUnscored: `${siteId}IncludeUnscored`,
    coverageTypes: `${siteId}CoverageTypes`,
  }
}
