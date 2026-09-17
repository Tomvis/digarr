import type { ServiceTestResult } from '@/core/types'
import { errMsg } from '@/core/validation'
import { createHttpClient } from './http'

/** music-rater's page envelope: `Page[AlbumSummary]`. */
type MusicRaterPage<T> = {
  items: T[]
  total: number
  limit: number
  offset: number
}

/** The subset of `AlbumSummary` digarr stores. */
type RawAlbumSummary = {
  id: number
  artist_name_raw: string
  album_title_raw: string
  release_year: number
  max_score_ratio?: number | null
  dr_value?: number | null
  genre_slugs?: string[]
  sources?: string[]
}

export type MusicRaterAlbum = {
  id: number
  artistName: string
  albumTitle: string
  releaseYear: number
  /** Cross-scale normalised 0..1. AMG is /5 and TPS is /10 natively. */
  maxScoreRatio: number | null
  drValue: number | null
  genreSlugs: string[]
  sources: string[]
}

/** music-rater caps `limit` at 500. Only consumed as this module's own default. */
const MUSIC_RATER_PAGE_SIZE = 500

function toAlbum(raw: RawAlbumSummary): MusicRaterAlbum {
  return {
    id: raw.id,
    artistName: raw.artist_name_raw,
    albumTitle: raw.album_title_raw,
    releaseYear: raw.release_year,
    maxScoreRatio: raw.max_score_ratio ?? null,
    drValue: raw.dr_value ?? null,
    genreSlugs: raw.genre_slugs ?? [],
    sources: raw.sources ?? [],
  }
}

export function createMusicRaterClient(url: string, apiKey: string, skipTlsVerify = false) {
  const http = createHttpClient({
    baseUrl: url,
    headers: { Authorization: `Bearer ${apiKey}` },
    skipTlsVerify,
  })

  async function testConnection(): Promise<ServiceTestResult> {
    try {
      // `/health` is music-rater's only unauthenticated route, so probing it
      // proves reachability but NOT that the key works. `/albums?limit=1`
      // goes through the policy, so a bad or revoked key surfaces here as a
      // 401 rather than at the first sync, hours later.
      await http.get<MusicRaterPage<RawAlbumSummary>>('/api/v1/albums?limit=1')
      return { success: true, message: 'Connected to music-rater' }
    } catch (err: unknown) {
      return { success: false, message: errMsg(err) }
    }
  }

  async function listScoredAlbums(
    offset: number,
    limit: number = MUSIC_RATER_PAGE_SIZE,
  ): Promise<{ items: MusicRaterAlbum[]; total: number }> {
    const page = await http.get<MusicRaterPage<RawAlbumSummary>>(
      `/api/v1/albums?has_score=true&sort_by=release_year&sort_dir=desc&limit=${limit}&offset=${offset}`,
    )
    return { items: (page.items ?? []).map(toAlbum), total: page.total ?? 0 }
  }

  return { testConnection, listScoredAlbums }
}
