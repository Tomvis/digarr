import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAICompatibleProvider } from '@/core/providers/openai-compatible'
import type { TasteProfile } from '@/core/types'

const TEST_BASE_URL = 'http://openai.example.com:8080'
const sampleProfile: TasteProfile = {
  topArtists: [{ name: 'Portishead', playCount: 50, source: 'lastfm' }],
  topGenres: [{ name: 'trip-hop', weight: 1 }],
  listeningPatterns: { totalListens: 200, recentTrend: 'stable' },
}

describe('OpenAICompatibleProvider', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')

  afterEach(() => fetchSpy.mockReset())

  it('sends request to custom base URL', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    artistName: 'Massive Attack',
                    reasoning: 'Trip-hop pioneers.',
                    confidence: 0.85,
                    genres: ['trip-hop', 'electronic'],
                  },
                ]),
              },
            },
          ],
        }),
      ),
    )

    const provider = new OpenAICompatibleProvider(TEST_BASE_URL, 'local-model', 'key123')
    const results = await provider.getRecommendations(sampleProfile)

    expect(results).toHaveLength(1)
    expect(results[0]?.artistName).toBe('Massive Attack')

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${TEST_BASE_URL}/v1/chat/completions`)
  })

  it.each([
    ['http://provider.example.com', 'http://provider.example.com/v1/chat/completions'],
    ['http://provider.example.com/v1', 'http://provider.example.com/v1/chat/completions'],
    ['http://provider.example.com/api', 'http://provider.example.com/api/chat/completions'],
    ['http://provider.example.com/api/v1', 'http://provider.example.com/api/v1/chat/completions'],
    [
      'http://provider.example.com/custom/chat/completions',
      'http://provider.example.com/custom/chat/completions',
    ],
  ])('resolves completion URL from %s', async (baseUrl, expectedUrl) => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: '[]' } }] })),
    )
    const provider = new OpenAICompatibleProvider(baseUrl, 'model')

    await provider.getRecommendations(sampleProfile)

    expect(fetchSpy.mock.calls[0]?.[0]).toBe(expectedUrl)
  })

  it('works without API key', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '[]' } }],
        }),
      ),
    )

    const provider = new OpenAICompatibleProvider(TEST_BASE_URL, 'model')
    await provider.getRecommendations({
      topArtists: [{ name: 'Test', playCount: 1, source: 'lastfm' }],
      topGenres: [{ name: 'rock', weight: 1 }],
      listeningPatterns: { totalListens: 1, recentTrend: 'stable' },
    })

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
  })

  it('includes Authorization header when API key provided', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '[]' } }],
        }),
      ),
    )

    const provider = new OpenAICompatibleProvider(TEST_BASE_URL, 'model', 'sk-key')
    await provider.getRecommendations({
      topArtists: [{ name: 'Test', playCount: 1, source: 'lastfm' }],
      topGenres: [{ name: 'rock', weight: 1 }],
      listeningPatterns: { totalListens: 1, recentTrend: 'stable' },
    })

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-key')
  })

  it('testConnection returns success on 200', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'pong' } }],
        }),
      ),
    )

    const provider = new OpenAICompatibleProvider(TEST_BASE_URL, 'model')
    const result = await provider.testConnection()
    expect(result.success).toBe(true)
    expect(result.message).toContain('openai.example.com:8080')
  })

  it('uses the configured timeout for connection tests and reports its duration', async () => {
    vi.useFakeTimers()
    const provider = new OpenAICompatibleProvider(TEST_BASE_URL, 'model', null, 30)
    const startedAt = Date.now()
    let abortedAfterMs: number | undefined
    fetchSpy.mockImplementationOnce(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const abortErr = new Error('aborted')
          abortErr.name = 'AbortError'
          init?.signal?.addEventListener('abort', () => {
            abortedAfterMs = Date.now() - startedAt
            reject(abortErr)
          })
        }),
    )

    try {
      const pending = provider.testConnection()
      await vi.advanceTimersByTimeAsync(30_000)

      await expect(pending).resolves.toEqual({
        success: false,
        message: 'OpenAI-Compatible connection test timed out after 30 seconds',
      })
      expect(abortedAfterMs).toBe(30_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('tests Open WebUI through its documented completion URL', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] })),
    )
    const provider = new OpenAICompatibleProvider('http://webui.example.com/api', 'model')

    await provider.testConnection()

    expect(fetchSpy.mock.calls[0]?.[0]).toBe('http://webui.example.com/api/chat/completions')
  })

  it('handles wrapped JSON object response', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  recommendations: [
                    {
                      artistName: 'Burial',
                      reasoning: 'UK dubstep.',
                      confidence: 0.8,
                      genres: ['dubstep'],
                    },
                  ],
                }),
              },
            },
          ],
        }),
      ),
    )

    const provider = new OpenAICompatibleProvider(TEST_BASE_URL, 'model')
    const results = await provider.getRecommendations({
      topArtists: [{ name: 'Test', playCount: 1, source: 'lastfm' }],
      topGenres: [{ name: 'electronic', weight: 1 }],
      listeningPatterns: { totalListens: 1, recentTrend: 'stable' },
    })

    expect(results).toHaveLength(1)
    expect(results[0]?.artistName).toBe('Burial')
  })

  const stallUntilAborted = (_url: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const abortErr = new Error('aborted')
      abortErr.name = 'AbortError'
      init?.signal?.addEventListener('abort', () => reject(abortErr))
    })

  it('retries an attempt that hits the configured timeout', async () => {
    // The configured timeout bounds ONE attempt, not the whole retry loop --
    // otherwise a single slow upstream eats the budget and p-retry bails on the
    // abort without ever retrying.
    vi.useFakeTimers()
    const provider = new OpenAICompatibleProvider(TEST_BASE_URL, 'model', null, 1)
    fetchSpy.mockImplementationOnce(stallUntilAborted)
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    recommendations: [
                      {
                        artistName: 'Burial',
                        reasoning: 'Similar textures.',
                        confidence: 0.9,
                        genres: ['electronic'],
                      },
                    ],
                  }),
                },
              },
            ],
          }),
        ),
    )

    try {
      const pending = provider.getRecommendations(sampleProfile)
      await vi.advanceTimersByTimeAsync(5000)
      await expect(pending).resolves.toHaveLength(1)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports the whole-call budget when the overall deadline elapses', async () => {
    vi.useFakeTimers()
    const provider = new OpenAICompatibleProvider(TEST_BASE_URL, 'model', null, 1)
    fetchSpy.mockImplementation(stallUntilAborted)

    try {
      const rejection = provider.getRecommendations(sampleProfile).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(20_000)
      const error = await rejection

      expect(error).toBeInstanceOf(Error)
      // 4 attempts x 1s plus 1+2+4s of backoff -- NOT the 1s per-attempt value,
      // which would misreport an 11s wait as a 1s one.
      expect((error as Error).message).toBe(
        'OpenAI-Compatible recommendation request timed out after 11 seconds',
      )
      expect(fetchSpy.mock.calls.length).toBeGreaterThan(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
