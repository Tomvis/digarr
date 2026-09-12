import { afterEach, describe, expect, it, vi } from 'vitest'
import { GeminiProvider } from '@/core/providers/gemini'
import type { TasteProfile } from '@/core/types'

const sampleProfile: TasteProfile = {
  topArtists: [{ name: 'Aphex Twin', playCount: 100, source: 'lastfm' }],
  topGenres: [{ name: 'electronic', weight: 1 }],
  listeningPatterns: { totalListens: 500, recentTrend: 'stable' },
}

describe('GeminiProvider', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')

  afterEach(() => fetchSpy.mockReset())

  it('strips maxItems from responseSchema (every served Gemini model 400s on it)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      recommendations: [
                        {
                          artistName: 'Boards of Canada',
                          reasoning: 'Similar textures.',
                          confidence: 0.9,
                          genres: ['electronic'],
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
      ),
    )

    await new GeminiProvider('key', 'gemini-3.6-flash').getRecommendations(sampleProfile)

    const call = fetchSpy.mock.calls[0] as [string | URL | Request, RequestInit | undefined]
    const body = JSON.parse(String(call[1]?.body))
    const schema = body.generationConfig.responseSchema

    // Recursively assert no maxItems survives anywhere in the sent schema.
    const findMaxItems = (node: unknown): boolean => {
      if (Array.isArray(node)) return node.some(findMaxItems)
      if (node && typeof node === 'object') {
        return Object.entries(node as Record<string, unknown>).some(
          ([k, v]) => k === 'maxItems' || findMaxItems(v),
        )
      }
      return false
    }
    expect(findMaxItems(schema)).toBe(false)

    // The shape-defining fields must survive the strip.
    expect(schema.properties.recommendations.type).toBe('array')
    expect(schema.properties.recommendations.items.properties.artistName.type).toBe('string')
    expect(schema.required).toEqual(['recommendations'])

    // Thinking is disabled and the output cap leaves room for a full response:
    // Gemini 3.x bills thoughts against maxOutputTokens, and 4096 truncated.
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 })
    expect(body.generationConfig.maxOutputTokens).toBe(16384)
  })

  it('sends prompt to Gemini generateContent endpoint', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify([
                      {
                        artistName: 'Boards of Canada',
                        reasoning: 'Ambient electronic.',
                        confidence: 0.9,
                        genres: ['ambient', 'electronic'],
                      },
                    ]),
                  },
                ],
              },
            },
          ],
        }),
      ),
    )

    const provider = new GeminiProvider('test-key', 'gemini-3-flash-preview')
    const results = await provider.getRecommendations(sampleProfile)

    expect(results).toHaveLength(1)
    expect(results[0]?.artistName).toBe('Boards of Canada')
    expect(fetchSpy).toHaveBeenCalledOnce()

    const call = fetchSpy.mock.calls[0] as [string | URL | Request, RequestInit | undefined]
    const [url, init] = call
    expect(String(url)).toContain('generativelanguage.googleapis.com')
    expect(String(url)).toContain('gemini-3-flash-preview')
    expect((init as RequestInit).headers).toEqual(
      expect.objectContaining({ 'x-goog-api-key': 'test-key' }),
    )
  })

  it('testConnection returns success on 200', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'pong' }] } }],
        }),
      ),
    )

    const provider = new GeminiProvider('test-key')
    const result = await provider.testConnection()
    expect(result.success).toBe(true)
  })

  it('testConnection returns failure on error', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))

    const provider = new GeminiProvider('bad-key')
    const result = await provider.testConnection()
    expect(result.success).toBe(false)
  })

  it('parses recommendations wrapped in markdown code fences', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: `\`\`\`json\n${JSON.stringify([
                      {
                        artistName: 'Autechre',
                        reasoning: 'IDM pioneers.',
                        confidence: 0.85,
                        genres: ['idm'],
                      },
                    ])}\n\`\`\``,
                  },
                ],
              },
            },
          ],
        }),
      ),
    )

    const provider = new GeminiProvider('test-key')
    const results = await provider.getRecommendations(sampleProfile)
    expect(results).toHaveLength(1)
    expect(results[0]?.artistName).toBe('Autechre')
  })

  it('throws a clear error on truncated JSON output', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: '[{"artistName": "Squarepusher", "reason' }] } },
          ],
        }),
      ),
    )

    const provider = new GeminiProvider('test-key')
    await expect(provider.getRecommendations(sampleProfile)).rejects.toThrow(/Malformed JSON array/)
  })

  it('handles empty response from Gemini', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [] })))

    const provider = new GeminiProvider('test-key')
    await expect(
      provider.getRecommendations({
        topArtists: [{ name: 'Test', playCount: 1, source: 'lastfm' }],
        topGenres: [{ name: 'rock', weight: 1 }],
        listeningPatterns: { totalListens: 1, recentTrend: 'stable' },
      }),
    ).rejects.toThrow()
  })

  it('aborts getRecommendations when configured timeout elapses', async () => {
    vi.useFakeTimers()
    const provider = new GeminiProvider('test-key', 'gemini-3-flash-preview', 1)
    fetchSpy.mockImplementationOnce(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const abortErr = new Error('aborted')
          abortErr.name = 'AbortError'
          init?.signal?.addEventListener('abort', () => reject(abortErr))
        }),
    )

    try {
      const pending = provider.getRecommendations(sampleProfile)
      const rejection = expect(pending).rejects.toThrow(/abort/i)
      await vi.advanceTimersByTimeAsync(1000)
      await rejection
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
