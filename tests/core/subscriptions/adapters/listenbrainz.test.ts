// @vitest-environment node
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createListenBrainzAdapter } from '@/core/subscriptions/adapters/listenbrainz'

let server: http.Server
let baseUrl: string

const freshReleasesFixture = {
  payload: {
    releases: [
      { artist_credit_name: 'Artist One', release_mbid: 'rel-1' },
      { artist_credit_name: 'Artist Two', release_mbid: 'rel-2' },
      { artist_credit_name: 'artist one', release_mbid: 'rel-3' }, // duplicate
      { artist_credit_name: 'Artist Three', release_mbid: 'rel-4' },
      { release_mbid: 'rel-5' }, // missing artist name
    ],
  },
}

const NEW_JAMS = '80d61d95-61b0-4a22-8556-443c0fb26078'
const OLD_JAMS = '11111111-2222-4333-8444-555555555555'
const EXPLORATION = 'c99f9e8d-77ab-446e-bf95-248bbc0ab535'

const jspfTrack = (creator: string, title: string, artistMbid: string, recordingMbid: string) => ({
  creator,
  title,
  identifier: [`https://musicbrainz.org/recording/${recordingMbid}`],
  extension: {
    'https://musicbrainz.org/doc/jspf#track': {
      additional_metadata: {
        artists: [{ artist_credit_name: creator, artist_mbid: artistMbid, join_phrase: '' }],
      },
      artist_identifiers: [`https://musicbrainz.org/artist/${artistMbid}`],
    },
  },
})

// Fork (MUSIC-114): album and cover-art release ride along onto the song rec.
const hakenTrack = {
  ...jspfTrack(
    'Haken',
    'Sempiternal Beings',
    '0246a3fd-a254-416d-8cd2-e31da4ac6f59',
    '06ee307a-4d83-4d5d-8cb8-64e379346d8c',
  ),
  album: 'Fauna',
  extension: {
    'https://musicbrainz.org/doc/jspf#track': {
      additional_metadata: {
        artists: [
          { artist_credit_name: 'Haken', artist_mbid: '0246a3fd-a254-416d-8cd2-e31da4ac6f59' },
        ],
        caa_release_mbid: 'd7fae1b8-fdfb-4c26-b230-6a3dd7b68d6d',
      },
    },
  },
}

const createdForEntry = (mbid: string, title: string, date: string) => ({
  playlist: {
    title,
    date,
    identifier: `https://listenbrainz.org/playlist/${mbid}`,
    track: [], // the list endpoints never include tracks
  },
})

// Oldest first on purpose: the newest Weekly Jams must win by date, not list order.
const createdForFixture = {
  playlist_count: 3,
  playlists: [
    createdForEntry(
      OLD_JAMS,
      'Weekly Jams for testuser, week of 2026-09-28 Mon',
      '2026-09-28T05:00:00+00:00',
    ),
    createdForEntry(
      EXPLORATION,
      'Weekly Exploration for testuser, week of 2026-10-05 Mon',
      '2026-10-05T05:49:10+00:00',
    ),
    createdForEntry(
      NEW_JAMS,
      'Weekly Jams for testuser, week of 2026-10-05 Mon',
      '2026-10-05T05:43:41+00:00',
    ),
  ],
}

const playlistFixtures: Record<string, unknown> = {
  [NEW_JAMS]: {
    playlist: {
      title: 'Weekly Jams for testuser, week of 2026-10-05 Mon',
      track: [
        jspfTrack(
          'Jam Artist X',
          'Track 1',
          'aaaaaaaa-0000-4000-8000-000000000001',
          'bbbbbbbb-0000-4000-8000-000000000001',
        ),
        jspfTrack(
          'Jam Artist Y',
          'Track 2',
          'aaaaaaaa-0000-4000-8000-000000000002',
          'bbbbbbbb-0000-4000-8000-000000000002',
        ),
        jspfTrack(
          'jam artist x',
          'Track 3',
          'aaaaaaaa-0000-4000-8000-000000000001',
          'bbbbbbbb-0000-4000-8000-000000000003',
        ),
        { creator: 'Name Only', title: 'Track 4' },
        { title: 'Track 5' }, // missing creator
        hakenTrack,
      ],
    },
  },
  [EXPLORATION]: {
    playlist: {
      title: 'Weekly Exploration for testuser, week of 2026-10-05 Mon',
      track: [
        jspfTrack(
          'Explore Artist',
          'New To You',
          'aaaaaaaa-0000-4000-8000-000000000005',
          'bbbbbbbb-0000-4000-8000-000000000005',
        ),
      ],
    },
  },
  [OLD_JAMS]: {
    playlist: {
      title: 'old',
      track: [
        jspfTrack(
          'Stale Artist',
          'Old',
          'aaaaaaaa-0000-4000-8000-000000000009',
          'bbbbbbbb-0000-4000-8000-000000000009',
        ),
      ],
    },
  },
}

const originalFetch = global.fetch
let requestLog: Array<{ path: string; headers: http.IncomingHttpHeaders }> = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? ''
    requestLog.push({ path: url, headers: req.headers })

    if (url.includes('/explore/fresh-releases')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(freshReleasesFixture))
      return
    }

    if (url.includes('/playlists/createdfor')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(createdForFixture))
      return
    }

    const playlistId = /\/playlist\/([0-9a-f-]+)/.exec(url)?.[1]
    if (playlistId && playlistFixtures[playlistId]) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(playlistFixtures[playlistId]))
      return
    }

    res.writeHead(404)
    res.end('{}')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}`

  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (new URL(url).hostname === 'api.listenbrainz.org') {
      const parsed = new URL(url)
      const mockUrl = `${baseUrl}${parsed.pathname}${parsed.search}`
      return originalFetch(mockUrl, init)
    }
    return originalFetch(input, init)
  }) as typeof fetch
})

afterAll(() => {
  server.close()
  global.fetch = originalFetch
})

describe('createListenBrainzAdapter', () => {
  function requireArtist<T>(value: T | undefined, message: string): T {
    if (value === undefined) {
      throw new Error(message)
    }
    return value
  }

  describe('fresh-releases', () => {
    it('fetches artists and deduplicates by lowercase name', async () => {
      const adapter = createListenBrainzAdapter({ username: 'testuser', token: 'testtoken' })
      const result = await adapter.fetch({ feedType: 'fresh-releases' })

      // One, Two, Three - duplicate of One filtered, missing artist skipped
      expect(result.artists).toHaveLength(3)
      const names = result.artists.map((a) => a.name)
      expect(names).toContain('Artist One')
      expect(names).toContain('Artist Two')
      expect(names).toContain('Artist Three')
    })

    it('sets correct source tag', async () => {
      const adapter = createListenBrainzAdapter({ username: 'testuser', token: 'testtoken' })
      const result = await adapter.fetch({ feedType: 'fresh-releases' })
      const firstArtist = requireArtist(result.artists[0], 'Expected first fresh-release artist')
      expect(firstArtist.source).toBe('listenbrainz:fresh-releases')
    })

    it('sets similarityScore 0.6', async () => {
      const adapter = createListenBrainzAdapter({ username: 'testuser', token: 'testtoken' })
      const result = await adapter.fetch({ feedType: 'fresh-releases' })
      for (const artist of result.artists) {
        expect(artist.similarityScore).toBe(0.6)
      }
    })
  })

  describe('weekly-jams', () => {
    it('fetches createdfor, then the newest Weekly Jams playlist, with a Chrome User-Agent', async () => {
      requestLog = []
      const adapter = createListenBrainzAdapter({ username: 'testuser', token: 'testtoken' })
      await adapter.fetch({ feedType: 'weekly-jams' })

      expect(requestLog.map((r) => r.path)).toEqual([
        '/1/user/testuser/playlists/createdfor',
        `/1/playlist/${NEW_JAMS}`,
      ])
      for (const r of requestLog) {
        expect(r.headers.authorization).toBe('Token testtoken')
        expect(r.headers['user-agent']).toMatch(/Chrome\//)
      }
    })

    it('maps the newest Weekly Jams to song recs, not artist recs (fork, MUSIC-114)', async () => {
      const adapter = createListenBrainzAdapter({ username: 'testuser', token: 'testtoken' })
      const result = await adapter.fetch({ feedType: 'weekly-jams' })

      // newest playlist wins over list order and Weekly Exploration is ignored;
      // the track without a creator is dropped
      expect(result.artists).toEqual([])
      expect(result.tracks?.map((t) => t.title)).toEqual([
        'Track 1',
        'Track 2',
        'Track 3',
        'Track 4',
        'Sempiternal Beings',
      ])
      expect(result.tracks?.[0]).toEqual({
        artistName: 'Jam Artist X',
        artistMbid: 'aaaaaaaa-0000-4000-8000-000000000001',
        title: 'Track 1',
        recordingMbid: 'bbbbbbbb-0000-4000-8000-000000000001',
        position: 0,
        total: 5,
        source: 'listenbrainz:weekly-jams',
      })
      expect(result.tracks?.[3]).toEqual({
        artistName: 'Name Only',
        title: 'Track 4',
        position: 3,
        total: 5,
        source: 'listenbrainz:weekly-jams',
      })
      expect(result.tracks?.[4]).toMatchObject({
        artistName: 'Haken',
        artistMbid: '0246a3fd-a254-416d-8cd2-e31da4ac6f59',
        recordingMbid: '06ee307a-4d83-4d5d-8cb8-64e379346d8c',
        album: 'Fauna',
        coverReleaseMbid: 'd7fae1b8-fdfb-4c26-b230-6a3dd7b68d6d',
      })
    })

    it('returns empty with a message when no Weekly Jams playlist exists', async () => {
      const noJamsServer = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            playlists: [
              createdForEntry(
                EXPLORATION,
                'Weekly Exploration for testuser',
                '2026-10-05T05:49:10+00:00',
              ),
            ],
          }),
        )
      })
      await new Promise<void>((r) => noJamsServer.listen(0, '127.0.0.1', r))
      const noJamsBase = `http://127.0.0.1:${(noJamsServer.address() as AddressInfo).port}`

      const savedFetch = global.fetch
      global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (new URL(url).hostname === 'api.listenbrainz.org') {
          const parsed = new URL(url)
          return originalFetch(`${noJamsBase}${parsed.pathname}${parsed.search}`, init)
        }
        return originalFetch(input, init)
      }) as typeof fetch

      try {
        const adapter = createListenBrainzAdapter({ username: 'testuser', token: 'testtoken' })
        const result = await adapter.fetch({ feedType: 'weekly-jams' })
        expect(result.artists).toHaveLength(0)
        expect(result.tracks).toEqual([])
        expect(result.message).toMatch(/Weekly Jams/)
      } finally {
        global.fetch = savedFetch
        noJamsServer.close()
      }
    })

    it.each([
      ['createdfor', 500],
      ['playlist', 503],
    ])('throws on a non-OK %s response', async (failing, status) => {
      const saved = global.fetch
      global.fetch = (async (input: RequestInfo | URL) =>
        failing === 'playlist' && String(input).includes('/playlists/createdfor')
          ? new Response(JSON.stringify(createdForFixture), { status: 200 })
          : new Response('nope', { status, statusText: 'Down' })) as typeof fetch
      try {
        const adapter = createListenBrainzAdapter({ username: 'testuser', token: 'testtoken' })
        await expect(adapter.fetch({ feedType: 'weekly-jams' })).rejects.toThrow(
          `ListenBrainz weekly-jams fetch failed: ${status}`,
        )
      } finally {
        global.fetch = saved
      }
    })
  })

  it('reads the Weekly Exploration playlist for the weekly-exploration feed', async () => {
    const adapter = createListenBrainzAdapter({ username: 'testuser', token: 'testtoken' })
    const result = await adapter.fetch({ feedType: 'weekly-exploration' })

    expect(result.artists).toEqual([])
    expect(result.tracks).toEqual([
      {
        artistName: 'Explore Artist',
        artistMbid: 'aaaaaaaa-0000-4000-8000-000000000005',
        title: 'New To You',
        recordingMbid: 'bbbbbbbb-0000-4000-8000-000000000005',
        position: 0,
        total: 1,
        source: 'listenbrainz:weekly-exploration',
      },
    ])
  })

  it('returns empty for unknown feedType', async () => {
    const adapter = createListenBrainzAdapter({ username: 'testuser', token: 'testtoken' })
    const result = await adapter.fetch({ feedType: 'unknown-feed' })
    expect(result.artists).toHaveLength(0)
  })

  it('handles empty fresh-releases response', async () => {
    const emptyServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ payload: { releases: [] } }))
    })
    await new Promise<void>((r) => emptyServer.listen(0, '127.0.0.1', r))
    const emptyAddr = emptyServer.address() as AddressInfo
    const emptyBase = `http://127.0.0.1:${emptyAddr.port}`

    const savedFetch = global.fetch
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (new URL(url).hostname === 'api.listenbrainz.org') {
        const parsed = new URL(url)
        return originalFetch(`${emptyBase}${parsed.pathname}${parsed.search}`, init)
      }
      return originalFetch(input, init)
    }) as typeof fetch

    const adapter = createListenBrainzAdapter({ username: 'testuser', token: 'testtoken' })
    const result = await adapter.fetch({ feedType: 'fresh-releases' })
    expect(result.artists).toHaveLength(0)

    global.fetch = savedFetch
    emptyServer.close()
  })

  it('applies the per-run limit option', async () => {
    const adapter = createListenBrainzAdapter({ username: 'testuser', token: 'testtoken' })
    const result = await adapter.fetch({ feedType: 'fresh-releases' }, { limit: 2 })
    expect(result.artists.map((a) => a.name)).toEqual(['Artist One', 'Artist Two'])
  })
})
