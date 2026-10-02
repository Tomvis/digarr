import type { DiscoveredArtist } from '@/core/types'

/** Default number of distinct artists a scan resolves against MusicBrainz. */
export const DEFAULT_MAX_RESOLVE_CANDIDATES = 300

export type PrefilterResult = {
  kept: DiscoveredArtist[]
  /** Distinct artists dropped as already known (owned/recommended/rejected/blocked/top). */
  droppedKnown: number
  /** Distinct artists dropped by the resolve cap (lowest-ranked first). */
  droppedByCap: number
}

/**
 * Trim discoveries BEFORE resolve, which costs one or more rate-limited
 * MusicBrainz calls per distinct artist (one every ~3 s). Scans discovered
 * ~1,800 artists and the post-score filter then discarded 90-97% of them, so
 * almost all of a 1-1.5 h scan was spent resolving artists that could never
 * be stored.
 *
 * 1. Drops artists whose MBID is already owned, recommended, rejected or
 *    blocked, or whose name is a top artist -- the same rules the filter
 *    stage applies afterwards, so results are unchanged.
 * 2. Caps what is left to `limit` distinct artists, ranked by how many
 *    sources found them, then by best similarity. Low-consensus,
 *    low-similarity candidates rarely clear the score threshold.
 *
 * Kept untouched: album candidates (release-group MBID; they bypass the
 * artist-existence filters) and any artist with an AI album suggestion
 * (net-new album discovery can promote an OWNED artist to an album rec).
 * Grouping mirrors resolve: by MBID when present, else by lowercased name.
 */
export function prefilterCandidates(
  discovered: DiscoveredArtist[],
  options: { excludeMbids: Set<string>; excludeNames: Set<string>; limit: number | null },
): PrefilterResult {
  const groups = new Map<string, DiscoveredArtist[]>()
  const passthrough: DiscoveredArtist[] = []
  for (const d of discovered) {
    if (d.releaseGroupMbid) {
      passthrough.push(d)
      continue
    }
    const key = d.mbid ? `mbid:${d.mbid}` : `name:${d.name.trim().toLowerCase()}`
    const group = groups.get(key)
    if (group) group.push(d)
    else groups.set(key, [d])
  }

  let droppedKnown = 0
  const candidates: Array<{
    items: DiscoveredArtist[]
    sources: number
    best: number
    keep: boolean
  }> = []
  for (const items of groups.values()) {
    const keep = items.some((d) => d.suggestedAlbum)
    const mbid = items.find((d) => d.mbid)?.mbid
    const known =
      (mbid !== undefined && options.excludeMbids.has(mbid)) ||
      items.some((d) => options.excludeNames.has(d.name.trim().toLowerCase()))
    if (known && !keep) {
      droppedKnown += 1
      continue
    }
    candidates.push({
      items,
      sources: new Set(items.map((d) => d.source)).size,
      best: Math.max(...items.map((d) => d.similarityScore)),
      keep,
    })
  }

  candidates.sort((a, b) => b.sources - a.sources || b.best - a.best)
  let droppedByCap = 0
  const kept: DiscoveredArtist[] = [...passthrough]
  let taken = 0
  for (const c of candidates) {
    if (!c.keep && options.limit !== null && taken >= options.limit) {
      droppedByCap += 1
      continue
    }
    taken += 1
    kept.push(...c.items)
  }
  return { kept, droppedKnown, droppedByCap }
}
