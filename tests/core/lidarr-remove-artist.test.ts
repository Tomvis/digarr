// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLidarrClient } from '@/core/clients/lidarr'

afterEach(() => vi.unstubAllGlobals())

describe('removeArtist', () => {
  it('issues a DELETE that does not delete files by default', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const client = createLidarrClient('http://lidarr', 'k')
    await client.removeArtist(42, { deleteFiles: false })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toContain('/api/v1/artist/42')
    expect(String(url)).toContain('deleteFiles=false')
    expect((init as RequestInit | undefined)?.method).toBe('DELETE')
  })

  it('throws on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    )
    const client = createLidarrClient('http://lidarr', 'k')
    await expect(client.removeArtist(42, { deleteFiles: false })).rejects.toThrow()
  })
})
