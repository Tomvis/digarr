// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSongpickTarget,
  pickRootFolderPath,
  songpickLidarrConnection,
} from '@/core/targets/songpick'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)
afterEach(() => fetchMock.mockReset())

const track = { artistMbid: 'a1', artistName: 'A', title: 'T', recordingMbid: 'r1' }

describe('songpick target', () => {
  it('maps wanted to a success result', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: 'wanted', album_name: 'Alb', edition: 'Deluxe' })),
    )
    const resolve = vi.fn().mockResolvedValue('/music/tom')
    const t = createSongpickTarget(5, { url: 'http://sp', resolveRootFolderPath: resolve })
    expect(t.id).toBe('songpick-5')
    expect(t.capabilities).toEqual(['addTrack'])
    const r = await t.addTrack?.(track, { rootFolderId: 2 })
    expect(r).toEqual({
      success: true,
      targetType: 'songpick',
      targetId: 5,
      songpickStatus: 'wanted',
      albumName: 'Alb',
      edition: 'Deluxe',
    })
    expect(resolve).toHaveBeenCalledWith(2)
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body).root_folder).toBe('/music/tom')
  })

  it('maps SongpickError to failure', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'nope' }), { status: 404 }))
    const t = createSongpickTarget(1, { url: 'http://sp', resolveRootFolderPath: async () => '/m' })
    expect(await t.addTrack?.(track)).toMatchObject({ success: false, error: 'nope' })
  })

  it('fails without a root folder', async () => {
    const t = createSongpickTarget(1, {
      url: 'http://sp',
      resolveRootFolderPath: async () => undefined,
    })
    expect(await t.addTrack?.(track)).toMatchObject({
      success: false,
      error: 'No Lidarr root folder configured for this user',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('target default root folder', () => {
  it('calls the resolver with undefined when no override is given', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'owned' })))
    const resolve = vi.fn().mockResolvedValue('/music/lera')
    const t = createSongpickTarget(2, { url: 'http://sp', resolveRootFolderPath: resolve })
    expect(await t.addTrack?.(track)).toMatchObject({ success: true, songpickStatus: 'owned' })
    expect(resolve).toHaveBeenCalledWith(undefined)
  })
})

describe('pickRootFolderPath', () => {
  const folders = [
    { id: 2, path: '/music/tom' },
    { id: 3, path: '/music/lera' },
  ]
  it('override wins', () => expect(pickRootFolderPath(folders, 3, 2)).toBe('/music/lera'))
  it('uses user pref without override', () =>
    expect(pickRootFolderPath(folders, undefined, 2)).toBe('/music/tom'))
  it('no pref gives undefined', () => expect(pickRootFolderPath(folders)).toBeUndefined())
  it('unknown id gives undefined', () => expect(pickRootFolderPath(folders, 9)).toBeUndefined())
  it('no folders gives undefined', () => expect(pickRootFolderPath([], 2)).toBeUndefined())
})

describe('songpickLidarrConnection', () => {
  const settings = { lidarrUrl: 'http://lidarr:8686', lidarrApiKey: 'k' }

  it('resolves a target linked to the server connection', () =>
    expect(
      songpickLidarrConnection(
        [{ type: 'lidarr', enabled: true, config: { useServerConnection: true } }],
        settings,
      ),
    ).toEqual({ url: 'http://lidarr:8686', apiKey: 'k', skipTlsVerify: false }))

  it('resolves a separate instance from its own url and key', () =>
    expect(
      songpickLidarrConnection(
        [{ type: 'lidarr', enabled: true, config: { url: 'http://other', apiKey: 'o' } }],
        settings,
      ),
    ).toEqual({ url: 'http://other', apiKey: 'o', skipTlsVerify: false }))

  it('skips disabled, non-Lidarr and unresolvable rows', () =>
    expect(
      songpickLidarrConnection(
        [
          { type: 'songpick', enabled: true, config: { url: 'http://sp' } },
          { type: 'lidarr', enabled: false, config: { useServerConnection: true } },
          { type: 'lidarr', enabled: true, config: {} },
        ],
        settings,
      ),
    ).toBeNull())

  it('a linked target without a server connection resolves to nothing', () =>
    expect(
      songpickLidarrConnection(
        [{ type: 'lidarr', enabled: true, config: { useServerConnection: true } }],
        null,
      ),
    ).toBeNull())
})
