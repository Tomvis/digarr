// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSongpickTarget } from '@/core/targets/songpick'

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
