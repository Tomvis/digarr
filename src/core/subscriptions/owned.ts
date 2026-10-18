import { normalizeAlbumTitle, normalizeArtistName } from '@/core/matching/normalize'
import type { LibraryTrack } from '@/core/types'

type TrackSearch = { searchTracks: (query: string, limit: number) => Promise<LibraryTrack[]> }

const SEARCH_LIMIT = 20

/**
 * Owned-song check against a Subsonic/Navidrome library: search3 for
 * "<artist> <title>", owned on a normalized artist + title match. Results are
 * cached per normalized artist + title for the run; a failed search throws
 * (the caller keeps the track) and is not cached, so it can be retried.
 */
export function createSubsonicOwnedCheck(
  client: TrackSearch,
): (artistName: string, title: string) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>()
  return (artistName, title) => {
    const artistKey = normalizeArtistName(artistName)
    const titleKey = normalizeAlbumTitle(title)
    const key = `${artistKey}\u0000${titleKey}`
    const cached = cache.get(key)
    if (cached) return cached
    const pending = client
      .searchTracks(`${artistName} ${title}`, SEARCH_LIMIT)
      .then((songs) =>
        songs.some(
          (s) =>
            normalizeArtistName(s.artist) === artistKey && normalizeAlbumTitle(s.name) === titleKey,
        ),
      )
    pending.catch(() => cache.delete(key))
    cache.set(key, pending)
    return pending
  }
}
