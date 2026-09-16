// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMusicRaterClient } from '@/core/clients/music-rater'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function jsonOk(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => mockFetch.mockReset())

describe('createMusicRaterClient', () => {
  it('sends the mr_ key as a bearer token', async () => {
    mockFetch.mockResolvedValueOnce(jsonOk({ status: 'ok', api_version: 'v1' }))
    await createMusicRaterClient('http://mr.example', 'mr_secret').testConnection()

    const init = mockFetch.mock.calls[0]?.[1] as RequestInit
    const headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers)
    expect(headers.get('Authorization')).toBe('Bearer mr_secret')
  })

  it('reports a successful probe', async () => {
    mockFetch.mockResolvedValueOnce(jsonOk({ status: 'ok', api_version: 'v1' }))
    const result = await createMusicRaterClient('http://mr.example', 'mr_k').testConnection()
    expect(result.success).toBe(true)
  })

  it('reports a failed probe without throwing', async () => {
    mockFetch.mockResolvedValueOnce(new Response('nope', { status: 401 }))
    const result = await createMusicRaterClient('http://mr.example', 'mr_k').testConnection()
    expect(result.success).toBe(false)
    expect(result.message).toBeTruthy()
  })

  it('maps a page of albums to camelCase and carries total', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonOk({
        items: [
          {
            id: 7,
            artist_name_raw: 'Sigur Rós',
            album_title_raw: 'Ágætis Byrjun',
            release_year: 1999,
            max_score_ratio: 0.92,
            dr_value: 12,
            genre_slugs: ['post-rock'],
            sources: ['amg'],
          },
        ],
        total: 1,
        limit: 500,
        offset: 0,
      }),
    )

    const page = await createMusicRaterClient('http://mr.example', 'mr_k').listScoredAlbums(0)
    expect(page.total).toBe(1)
    expect(page.items[0]).toEqual({
      id: 7,
      artistName: 'Sigur Rós',
      albumTitle: 'Ágætis Byrjun',
      releaseYear: 1999,
      maxScoreRatio: 0.92,
      drValue: 12,
      genreSlugs: ['post-rock'],
      sources: ['amg'],
    })
  })

  it('requests only scored albums, newest first, at the requested offset', async () => {
    mockFetch.mockResolvedValueOnce(jsonOk({ items: [], total: 0, limit: 500, offset: 500 }))
    await createMusicRaterClient('http://mr.example', 'mr_k').listScoredAlbums(500)

    const url = mockFetch.mock.calls[0]?.[0] as string
    expect(url).toContain('/api/v1/albums')
    expect(url).toContain('has_score=true')
    expect(url).toContain('limit=500')
    expect(url).toContain('offset=500')
  })
})
