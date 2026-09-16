import type { MBReleaseGroup } from '@/core/clients/musicbrainz'
import { normalizeAlbumTitle as normalizeTitle } from '@/core/matching/normalize'

export type PopularAlbumCandidate = {
  title: string
  releaseDate?: string
  popularity: number
}

export type PopularReleaseGroup = MBReleaseGroup & {
  popularity: number
}

const ALBUM_TYPES = new Set(['album'])

export function selectPopularReleaseGroups(
  candidates: PopularAlbumCandidate[],
  releaseGroups: MBReleaseGroup[],
  limit = 3,
): PopularReleaseGroup[] {
  const albumGroups = releaseGroups.filter((group) => ALBUM_TYPES.has(group.type.toLowerCase()))
  const groupsByTitle = new Map<string, MBReleaseGroup[]>()

  for (const group of albumGroups) {
    const normalized = normalizeTitle(group.title)
    groupsByTitle.set(normalized, [...(groupsByTitle.get(normalized) ?? []), group])
  }

  const selected: PopularReleaseGroup[] = []
  const usedIds = new Set<string>()
  const rankedCandidates = [...candidates].sort((a, b) => b.popularity - a.popularity)

  for (const candidate of rankedCandidates) {
    if (selected.length >= limit) break

    const matches = groupsByTitle.get(normalizeTitle(candidate.title)) ?? []
    if (matches.length !== 1) continue

    const match = matches[0]
    if (!match || usedIds.has(match.id)) continue

    usedIds.add(match.id)
    selected.push({ ...match, popularity: candidate.popularity })
  }

  return selected
}
