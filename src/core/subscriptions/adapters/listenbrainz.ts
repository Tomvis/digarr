import type { RadioMode, TagRadioInput } from '@/core/clients/listenbrainz'
import { createListenBrainzClient } from '@/core/clients/listenbrainz'
import { createMusicBrainzClient } from '@/core/clients/musicbrainz'
import { resolveTagRadioRecordings } from '@/core/clients/tag-radio-resolver'
import { deduplicateByName } from '@/core/subscriptions/dedup'
import type {
  AdapterConfigField,
  AdapterResult,
  SubscriptionAdapter,
} from '@/core/subscriptions/types'
import type { DiscoveredTrack } from '@/core/types'

const CONFIG_FIELDS: AdapterConfigField[] = [
  {
    key: 'feedType',
    label: 'Feed Type',
    type: 'select',
    required: true,
    options: [
      { value: 'fresh-releases', label: 'Fresh Releases' },
      { value: 'weekly-jams', label: 'Weekly Jams' },
      { value: 'weekly-exploration', label: 'Weekly Exploration' },
      { value: 'artist-radio', label: 'Artist Radio' },

      { value: 'similar-users', label: 'Similar Users' },
      { value: 'tag-radio', label: 'Tag Radio' },
    ],
    helpText: 'Which ListenBrainz feed to pull artists from.',
  },
]

type FreshRelease = {
  artist_credit_name?: string
  release_mbid?: string
}

type FreshReleasesPayload = {
  payload?: {
    releases?: FreshRelease[]
  }
}

const JSPF_TRACK_EXT = 'https://musicbrainz.org/doc/jspf#track'
const RECORDING_URL = /musicbrainz\.org\/recording\/([0-9a-f-]{36})/i
const CHROME_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

type JspfTrack = {
  creator?: string
  title?: string
  album?: string
  identifier?: string[]
  extension?: Record<
    string,
    {
      additional_metadata?: { artists?: Array<{ artist_mbid?: string }>; caa_release_mbid?: string }
    }
  >
}

type JspfPlaylist = {
  title?: string
  date?: string
  identifier?: string
  track?: JspfTrack[]
}

type JspfResponse = {
  playlist?: JspfPlaylist
}

type UserPlaylistsResponse = {
  playlists?: JspfResponse[]
}

const LB_BASE = 'https://api.listenbrainz.org/1'

export function createListenBrainzAdapter(deps: {
  username: string
  token: string
}): SubscriptionAdapter {
  return {
    type: 'listenbrainz',
    label: 'ListenBrainz',
    configFields: CONFIG_FIELDS,

    async fetch(
      config: Record<string, unknown>,
      _options?: { limit?: number },
    ): Promise<AdapterResult> {
      const feedType = String(config.feedType ?? 'fresh-releases').trim()

      if (feedType === 'fresh-releases') {
        return fetchFreshReleases(deps.token)
      }

      if (feedType === 'weekly-jams') {
        return fetchLbCreatedForPlaylist(
          deps.username,
          deps.token,
          'Weekly Jams for',
          'listenbrainz:weekly-jams',
        )
      }

      if (feedType === 'weekly-exploration') {
        return fetchLbCreatedForPlaylist(
          deps.username,
          deps.token,
          'Weekly Exploration for',
          'listenbrainz:weekly-exploration',
        )
      }

      if (feedType === 'artist-radio') {
        return fetchArtistRadio(deps, config)
      }

      if (feedType === 'similar-users') {
        return fetchSimilarUsers(deps, config)
      }

      if (feedType === 'tag-radio') {
        return fetchTagRadio(deps, config)
      }

      return { artists: [] }
    },
  }
}

async function fetchFreshReleases(token: string): Promise<AdapterResult> {
  const url = `${LB_BASE}/explore/fresh-releases?days=14`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  let res: Response
  try {
    res = await fetch(url, {
      headers: { Authorization: `Token ${token}` },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    throw new Error(`ListenBrainz fresh-releases fetch failed: ${res.status} ${res.statusText}`)
  }

  const data = (await res.json()) as FreshReleasesPayload
  const releases = (data.payload?.releases ?? []).flatMap((r) =>
    r.artist_credit_name ? [{ name: r.artist_credit_name }] : [],
  )

  const artists = deduplicateByName(releases, (r) => ({
    name: r.name,
    similarityScore: 0.6,
    source: 'listenbrainz:fresh-releases',
  }))

  return { artists }
}

async function fetchArtistRadio(
  deps: { username: string; token: string },
  config: Record<string, unknown>,
): Promise<AdapterResult> {
  const client = createListenBrainzClient(deps.username, deps.token)
  const mbid = String(config.seedArtistMbid ?? '')
  const mode = (config.adventurousness as RadioMode) ?? 'medium'
  if (!mbid) return { artists: [] }
  const radio = await client.getArtistRadio(mbid, mode)
  return {
    artists: radio.map((a) => ({
      name: a.name,
      similarityScore: a.score,
      source: 'listenbrainz:artist-radio',
    })),
  }
}

async function fetchSimilarUsers(
  deps: { username: string; token: string },
  config: Record<string, unknown>,
): Promise<AdapterResult> {
  const client = createListenBrainzClient(deps.username, deps.token)
  const maxUsers = Math.min(Math.max(1, Number(config.maxUsers) || 3), 10)
  const similarUsers = await client.getSimilarUsers()
  const topUsers = similarUsers.slice(0, maxUsers)

  const seen = new Set<string>()
  const artists: AdapterResult['artists'] = []

  for (const simUser of topUsers) {
    // One similar user without recent stats (or a transient error) must not
    // sink the whole run; fall back to the year when the month is empty.
    let topArtists: Awaited<ReturnType<typeof client.getTopArtistsForUser>> = []
    try {
      topArtists = await client.getTopArtistsForUser(simUser.username, 'month')
      if (topArtists.length === 0) {
        topArtists = await client.getTopArtistsForUser(simUser.username, 'year')
      }
    } catch (err: unknown) {
      console.warn(
        `[listenbrainz] similar user ${simUser.username} skipped: ${err instanceof Error ? err.message : String(err)}`,
      )
      continue
    }
    for (const artist of topArtists) {
      const key = artist.name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      artists.push({
        name: artist.name,
        mbid: artist.mbid,
        similarityScore: simUser.similarity * 0.8,
        source: 'listenbrainz:similar-users',
      })
    }
  }

  return { artists }
}

async function fetchTagRadio(
  deps: { username: string; token: string },
  config: Record<string, unknown>,
): Promise<AdapterResult> {
  const client = createListenBrainzClient(deps.username, deps.token)

  const rawExpr = String(config.rawTagExpression ?? '').trim()
  let tags: TagRadioInput[]
  if (rawExpr) {
    const pattern = /\(([^)]+)\):(\d+)/g
    const results: TagRadioInput[] = []
    for (const matchResult of rawExpr.matchAll(pattern)) {
      results.push({ tag: String(matchResult[1]), weight: Number(matchResult[2]) })
    }
    tags = results.length > 0 ? results : [{ tag: rawExpr, weight: 1 }]
  } else {
    const tagsRaw = config.tags
    type TagEntry = { tag?: unknown; weight?: unknown }
    tags = Array.isArray(tagsRaw)
      ? (tagsRaw as TagEntry[])
          .filter((t) => String(t.tag ?? '').trim())
          .map((t) => ({ tag: String(t.tag).trim(), weight: Number(t.weight) || 1 }))
      : []
  }

  if (tags.length === 0) return { artists: [] }

  const count = Number(config.count) || 25
  const recordings = await client.getTagRadio(tags, { count })

  const { db } = await import('@/db')
  const mbClient = createMusicBrainzClient()
  const resolved = await resolveTagRadioRecordings(recordings, mbClient, db)

  return {
    artists: resolved.map((a) => ({
      name: a.artistName,
      similarityScore: a.score,
      source: 'listenbrainz:tag-radio',
    })),
  }
}

async function lbGetJson<T>(url: string, token: string, label: string): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  let res: Response
  try {
    res = await fetch(url, {
      headers: { Authorization: `Token ${token}`, 'User-Agent': CHROME_USER_AGENT },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    throw new Error(`ListenBrainz ${label} fetch failed: ${res.status} ${res.statusText}`)
  }
  return (await res.json()) as T
}

const MBID_TAIL = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/i

export async function fetchLbCreatedForPlaylist(
  username: string,
  token: string,
  titlePrefix: 'Weekly Jams for' | 'Weekly Exploration for',
  source: string,
): Promise<AdapterResult> {
  const label = source.replace('listenbrainz:', '')
  const list = await lbGetJson<UserPlaylistsResponse>(
    `${LB_BASE}/user/${encodeURIComponent(username)}/playlists/createdfor`,
    token,
    label,
  )

  const prefix = titlePrefix.toLowerCase()
  let newest: JspfPlaylist | undefined
  for (const entry of list.playlists ?? []) {
    const pl = entry.playlist
    if (!pl?.title?.toLowerCase().startsWith(prefix)) continue
    // `>=` keeps the later list entry on equal/missing dates (list order fallback).
    if (!newest || (pl.date ?? '') >= (newest.date ?? '')) newest = pl
  }

  const mbid = newest?.identifier ? MBID_TAIL.exec(newest.identifier)?.[1] : undefined
  if (!mbid) return { artists: [], tracks: [] }

  const full = await lbGetJson<JspfResponse>(`${LB_BASE}/playlist/${mbid}`, token, label)
  const jspfTracks = (full.playlist?.track ?? []).filter((t) => t.creator && t.title)

  const tracks: DiscoveredTrack[] = jspfTracks.map((t, position) => {
    const meta = t.extension?.[JSPF_TRACK_EXT]?.additional_metadata
    const recordingMbid = t.identifier?.map((i) => RECORDING_URL.exec(i)?.[1]).find(Boolean)
    return {
      artistName: t.creator as string,
      ...(meta?.artists?.[0]?.artist_mbid ? { artistMbid: meta.artists[0].artist_mbid } : {}),
      title: t.title as string,
      ...(recordingMbid ? { recordingMbid } : {}),
      ...(t.album ? { album: t.album } : {}),
      ...(meta?.caa_release_mbid ? { coverReleaseMbid: meta.caa_release_mbid } : {}),
      position,
      total: jspfTracks.length,
      source,
    }
  })

  return { artists: [], tracks }
}
