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

const PL = 'https://listenbrainz.org/playlist/'
const MBID_OLD_JAMS = '11111111-1111-1111-1111-111111111111'
const MBID_NEW_JAMS = '22222222-2222-2222-2222-222222222222'
const MBID_EXPLORE = '33333333-3333-3333-3333-333333333333'

const createdForFixture = {
  playlist_count: 3,
  playlists: [
    {
      playlist: {
        title: 'Weekly Exploration for testuser, week of 2026-10-05 Mon',
        date: '2026-10-05T00:05:00+00:00',
        identifier: `${PL}${MBID_EXPLORE}`,
        track: [],
      },
    },
    {
      playlist: {
        title: 'Weekly Jams for testuser, week of 2026-10-05 Mon',
        date: '2026-10-05T00:04:00+00:00',
        identifier: `${PL}${MBID_NEW_JAMS}`,
        track: [],
      },
    },
    {
      playlist: {
        title: 'Weekly Jams for testuser, week of 2026-09-28 Mon',
        date: '2026-09-28T00:04:00+00:00',
        identifier: `${PL}${MBID_OLD_JAMS}`,
        track: [],
      },
    },
  ],
}

const hakenTrack = {
  creator: 'Haken',
  title: 'Sempiternal Beings',
  album: 'Fauna',
  identifier: ['https://musicbrainz.org/recording/06ee307a-4d83-4d5d-8cb8-64e379346d8c'],
  extension: {
    'https://musicbrainz.org/doc/jspf#track': {
      additional_metadata: {
        artists: [{ artist_mbid: '0246a3fd-a254-416d-8cd2-e31da4ac6f59' }],
        caa_release_mbid: 'd7fae1b8-fdfb-4c26-b230-6a3dd7b68d6d',
      },
    },
  },
}

const playlistFixtures: Record<string, unknown> = {
  [MBID_OLD_JAMS]: { playlist: { track: [{ creator: 'Old Artist', title: 'Old Song' }] } },
  [MBID_NEW_JAMS]: {
    playlist: { track: [hakenTrack, { creator: 'Plain Artist', title: 'Plain Song' }] },
  },
  [MBID_EXPLORE]: { playlist: { track: [{ creator: 'Explorer', title: 'Fresh Song' }] } },
}

let requestLog: Array<{ path: string; headers: http.IncomingHttpHeaders }> = []

const originalFetch = global.fetch

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

    const pl = /\/1\/playlist\/([^/?]+)/.exec(url)
    if (pl?.[1] && playlistFixtures[pl[1]]) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(playlistFixtures[pl[1]]))
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
    if (url.includes('api.listenbrainz.org')) {
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

  it('has correct type and label', () => {
    const adapter = createListenBrainzAdapter({ username: 'testuser', token: 'testtoken' })
    expect(adapter.type).toBe('listenbrainz')
    expect(adapter.label).toBeTruthy()
  })

  it('has feedType configField as select', () => {
    const adapter = createListenBrainzAdapter({ username: 'testuser', token: 'testtoken' })
    const feedTypeField = adapter.configFields.find((f) => f.key === 'feedType')
    expect(feedTypeField).toBeTruthy()
    if (!feedTypeField) {
      throw new Error('Expected feedType config field')
    }
    expect(feedTypeField.type).toBe('select')
    const values = feedTypeField.options?.map((o) => o.value) ?? []
    expect(values).toContain('fresh-releases')
    expect(values).toContain('weekly-jams')
  })

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
    it('fetches createdfor, then the newest Weekly Jams playlist', async () => {
      requestLog = []
      const adapter = createListenBrainzAdapter({ username: 'testuser', token: 'testtoken' })
      await adapter.fetch({ feedType: 'weekly-jams' })

      expect(requestLog.map((r) => r.path)).toEqual([
        '/1/user/testuser/playlists/createdfor',
        `/1/playlist/${MBID_NEW_JAMS}`,
      ])
      for (const r of requestLog) {
        expect(r.headers.authorization).toBe('Token testtoken')
        expect(r.headers['user-agent']).toMatch(/Chrome\//)
      }
    })

    it('maps JSPF tracks to DiscoveredTrack', async () => {
      const adapter = createListenBrainzAdapter({ username: 'testuser', token: 'testtoken' })
      const result = await adapter.fetch({ feedType: 'weekly-jams' })

      expect(result.artists).toEqual([])
      expect(result.tracks).toHaveLength(2)
      expect(result.tracks?.[0]).toEqual({
        artistName: 'Haken',
        artistMbid: '0246a3fd-a254-416d-8cd2-e31da4ac6f59',
        title: 'Sempiternal Beings',
        recordingMbid: '06ee307a-4d83-4d5d-8cb8-64e379346d8c',
        album: 'Fauna',
        coverReleaseMbid: 'd7fae1b8-fdfb-4c26-b230-6a3dd7b68d6d',
        position: 0,
        total: 2,
        source: 'listenbrainz:weekly-jams',
      })
      expect(result.tracks?.[1]).toMatchObject({
        artistName: 'Plain Artist',
        title: 'Plain Song',
        position: 1,
        total: 2,
      })
      expect(result.tracks?.[1]?.recordingMbid).toBeUndefined()
    })

    it('throws on a non-OK createdfor response', async () => {
      const saved = global.fetch
      global.fetch = (async () =>
        new Response('nope', { status: 500, statusText: 'Boom' })) as typeof fetch
      try {
        const adapter = createListenBrainzAdapter({ username: 'testuser', token: 'testtoken' })
        await expect(adapter.fetch({ feedType: 'weekly-jams' })).rejects.toThrow(
          'ListenBrainz weekly-jams fetch failed: 500',
        )
      } finally {
        global.fetch = saved
      }
    })
  })

  describe('weekly-exploration', () => {
    it('picks the Weekly Exploration playlist', async () => {
      requestLog = []
      const adapter = createListenBrainzAdapter({ username: 'testuser', token: 'testtoken' })
      const result = await adapter.fetch({ feedType: 'weekly-exploration' })

      expect(requestLog[1]?.path).toBe(`/1/playlist/${MBID_EXPLORE}`)
      expect(result.artists).toEqual([])
      expect(result.tracks).toEqual([
        {
          artistName: 'Explorer',
          title: 'Fresh Song',
          position: 0,
          total: 1,
          source: 'listenbrainz:weekly-exploration',
        },
      ])
    })

    it('is offered as a feedType option', () => {
      const adapter = createListenBrainzAdapter({ username: 'testuser', token: 'testtoken' })
      const field = adapter.configFields.find((f) => f.key === 'feedType')
      expect(field?.options).toContainEqual({
        value: 'weekly-exploration',
        label: 'Weekly Exploration',
      })
    })
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
      if (url.includes('api.listenbrainz.org')) {
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

  it('returns empty when no Weekly Jams playlist found', async () => {
    const noJamsServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          playlists: [
            {
              playlist: {
                title: 'Some Other Playlist',
                track: [{ creator: 'Some Artist', title: 'Track' }],
              },
            },
          ],
        }),
      )
    })
    await new Promise<void>((r) => noJamsServer.listen(0, '127.0.0.1', r))
    const noJamsAddr = noJamsServer.address() as AddressInfo
    const noJamsBase = `http://127.0.0.1:${noJamsAddr.port}`

    const savedFetch = global.fetch
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('api.listenbrainz.org')) {
        const parsed = new URL(url)
        return originalFetch(`${noJamsBase}${parsed.pathname}${parsed.search}`, init)
      }
      return originalFetch(input, init)
    }) as typeof fetch

    const adapter = createListenBrainzAdapter({ username: 'testuser', token: 'testtoken' })
    const result = await adapter.fetch({ feedType: 'weekly-jams' })
    expect(result).toEqual({ artists: [], tracks: [] })

    global.fetch = savedFetch
    noJamsServer.close()
  })
})
