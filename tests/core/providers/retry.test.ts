// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { fetchWithRetry, overallTimeoutMsFor, redactSecrets } from '@/core/providers/retry'

// A fetch that never settles on its own: it rejects the way a real `fetch` does
// when the signal it was handed is aborted, and otherwise hangs. That is what
// makes "which clock aborted this?" observable.
const stallUntilAborted = (_url: unknown, init?: RequestInit): Promise<Response> =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))
    })
  })

describe('fetchWithRetry', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  test('returns the response on the first successful attempt', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const res = await fetchWithRetry('https://example.com', {}, { minTimeout: 1 })
    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test('retries on 500 responses and eventually returns success', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(new Response('boom', { status: 502 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const res = await fetchWithRetry('https://example.com', {}, { minTimeout: 1, retries: 3 })
    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  test('does not retry on 4xx other than 429', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('nope', { status: 401 }))
    await expect(
      fetchWithRetry('https://example.com', {}, { minTimeout: 1, retries: 5 }),
    ).rejects.toThrow(/client error 401/)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test('retries on 429 responses', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response('slow down', { status: 429 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const res = await fetchWithRetry('https://example.com', {}, { minTimeout: 1 })
    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  test('honours integer Retry-After header delay', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response('slow down', { status: 429, headers: { 'Retry-After': '1' } }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const started = Date.now()
    const res = await fetchWithRetry('https://example.com', {}, { minTimeout: 1, retries: 2 })
    const elapsed = Date.now() - started
    expect(res.status).toBe(200)
    // ~1s sleep from Retry-After; give generous slack for CI jitter
    expect(elapsed).toBeGreaterThanOrEqual(900)
  })

  test('exhausts retries and surfaces the upstream failure', async () => {
    fetchSpy.mockResolvedValue(new Response('boom', { status: 500 }))
    await expect(
      fetchWithRetry('https://example.com', {}, { minTimeout: 1, retries: 2 }),
    ).rejects.toThrow(/upstream 500/)
    // 1 initial + 2 retries = 3 calls
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  test('includes the response body snippet in 4xx errors', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('{"error":"model \'llama3\' not found, try pulling it first"}', { status: 404 }),
    )
    await expect(
      fetchWithRetry('https://example.com', {}, { minTimeout: 1, retries: 2 }),
    ).rejects.toThrow(/client error 404: .*model 'llama3' not found/)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test('includes the response body snippet in 5xx errors', async () => {
    // Fresh Response per attempt - a body can only be consumed once.
    fetchSpy.mockImplementation(async () => new Response('upstream exploded', { status: 500 }))
    await expect(
      fetchWithRetry('https://example.com', {}, { minTimeout: 1, retries: 1 }),
    ).rejects.toThrow(/upstream 500: upstream exploded/)
  })

  test('redacts credential-shaped substrings from error body snippets', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        '{"error":"Invalid key sk-proj-abc123def456ghi789 for https://api.example.com/v1?api_key=topsecret123 Bearer eyJhbGciOiJIUzI1NiJ9.payload"}',
        { status: 401 },
      ),
    )
    const err = await fetchWithRetry(
      'https://example.com',
      {},
      { minTimeout: 1, retries: 1 },
    ).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    const message = (err as Error).message
    expect(message).toContain('client error 401')
    expect(message).not.toContain('sk-proj-abc123def456ghi789')
    expect(message).not.toContain('topsecret123')
    expect(message).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(message).toContain('[redacted]')
  })

  test('retries an attempt that hits the per-attempt timeout', async () => {
    // The production bug: a slow upstream 5xx consumed the whole budget on one
    // attempt, so the retries the policy promised never ran. Each attempt must
    // get its own clock.
    fetchSpy.mockImplementationOnce(stallUntilAborted)
    fetchSpy.mockImplementationOnce(async () => new Response('ok', { status: 200 }))

    const res = await fetchWithRetry(
      'https://example.com',
      {},
      { minTimeout: 1, retries: 2, attemptTimeoutMs: 40 },
    )
    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  test('surfaces the per-attempt timeout when every attempt stalls', async () => {
    fetchSpy.mockImplementation(stallUntilAborted)
    await expect(
      fetchWithRetry(
        'https://example.com',
        {},
        { minTimeout: 1, retries: 1, attemptTimeoutMs: 40 },
      ),
    ).rejects.toThrow(/attempt timed out after 40ms/)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  test("a caller's own abort ends the loop immediately", async () => {
    // The caller's controller is the overall deadline (and stays armed while the
    // caller reads the body). Its expiry is not retriable.
    const controller = new AbortController()
    fetchSpy.mockImplementation(stallUntilAborted)
    setTimeout(() => controller.abort(), 20)
    await expect(
      fetchWithRetry(
        'https://example.com',
        { signal: controller.signal },
        { minTimeout: 1, retries: 5, attemptTimeoutMs: 10_000 },
      ),
    ).rejects.toThrow(/aborted/)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test('a caller abort still wins when no per-attempt timeout is configured', async () => {
    const controller = new AbortController()
    fetchSpy.mockImplementation(stallUntilAborted)
    setTimeout(() => controller.abort(), 20)
    await expect(
      fetchWithRetry(
        'https://example.com',
        { signal: controller.signal },
        { minTimeout: 1, retries: 5 },
      ),
    ).rejects.toThrow(/aborted/)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test('passes the caller signal through untouched when no per-attempt timeout is set', async () => {
    const controller = new AbortController()
    fetchSpy.mockResolvedValueOnce(new Response('ok', { status: 200 }))
    await fetchWithRetry('https://example.com', { signal: controller.signal }, { minTimeout: 1 })
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit
    expect(init.signal).toBe(controller.signal)
  })

  test('collapses whitespace and truncates long error bodies', async () => {
    const longBody = `line one\nline two   spaced\n${'x'.repeat(500)}`
    fetchSpy.mockResolvedValueOnce(new Response(longBody, { status: 400 }))
    const err = await fetchWithRetry(
      'https://example.com',
      {},
      { minTimeout: 1, retries: 1 },
    ).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    const message = (err as Error).message
    expect(message).toContain('client error 400: line one line two spaced')
    expect(message.length).toBeLessThanOrEqual('client error 400: '.length + 200)
  })
})

describe('redactSecrets', () => {
  test('redacts Google-style AIza API keys', () => {
    // Fixture tail is 30 chars: exercises our {30,} pattern while staying
    // below the 35-char signature real secret scanners alert on.
    const text = 'key=AIzaSyA-1234567890abcdefghijklmnop is invalid'
    expect(redactSecrets(text)).toBe('key=[redacted] is invalid')
  })

  test('redacts the password from a URL credential, keeping the username', () => {
    const text = 'failed to connect to https://user:hunter2@host/path'
    expect(redactSecrets(text)).toBe('failed to connect to https://user:[redacted]@host/path')
  })

  test('leaves non-secret UUIDs and git SHAs unchanged', () => {
    const text =
      'artist 123e4567-e89b-12d3-a456-426614174000 at commit 27b89b2225b3a1e8c0f4d5e6a7b8c9d0e1f2a3b4'
    expect(redactSecrets(text)).toBe(text)
  })
})

describe('overallTimeoutMsFor', () => {
  test('budgets every attempt plus the backoff between them', () => {
    // 4 attempts x 60s, plus 1s + 2s + 4s of exponential backoff.
    expect(overallTimeoutMsFor(60_000, 3, 1000, 2)).toBe(60_000 * 4 + 7000)
  })

  test('a zero-retry budget is exactly one attempt', () => {
    expect(overallTimeoutMsFor(5000, 0)).toBe(5000)
  })
})
