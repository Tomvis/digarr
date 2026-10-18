// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createSongpickClient, SongpickError } from '@/core/clients/songpick'

const req = {
  root_folder: '/music',
  artist_name: 'A',
  artist_mbid: 'm1',
  track_name: 'T',
  recording_mbid: 'r1',
}

describe('songpick client', () => {
  it('posts the exact body to /song with a Chrome UA and parses 200', async () => {
    const f = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: 'wanted', album_name: 'Alb', edition: 'Deluxe' })),
      )
    const c = createSongpickClient('http://sp:9394/', { fetch: f as unknown as typeof fetch })
    await expect(c.want(req)).resolves.toMatchObject({ status: 'wanted', album_name: 'Alb' })
    const [url, init] = f.mock.calls[0] as [string, RequestInit & { body: string }]
    expect(url).toBe('http://sp:9394/song')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual(req)
    expect(new Headers(init.headers).get('User-Agent')).toMatch(/Chrome\//)
  })

  it('throws SongpickError with the body error on 422', async () => {
    const f = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: 'no match' }), { status: 422 }))
    const c = createSongpickClient('http://sp', { fetch: f as unknown as typeof fetch })
    const err = await c.want(req).catch((e) => e)
    expect(err).toBeInstanceOf(SongpickError)
    expect(err.status).toBe(422)
    expect(err.message).toBe('no match')
  })

  it('aborts after timeoutMs', async () => {
    const f = vi.fn(
      (_u: string, init: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init.signal?.addEventListener('abort', () => rej(init.signal?.reason))
        }),
    )
    const c = createSongpickClient('http://sp', {
      timeoutMs: 20,
      fetch: f as unknown as typeof fetch,
    })
    const err = await c.want(req).catch((e) => e)
    expect(err).toMatchObject({ name: 'TimeoutError' })
  })

  it('throws SongpickError on a 200 without a usable body', async () => {
    for (const body of ['', 'not json', '{"x":1}']) {
      const f = vi.fn().mockResolvedValue(new Response(body))
      const c = createSongpickClient('http://sp', { fetch: f as unknown as typeof fetch })
      await expect(c.want(req)).rejects.toBeInstanceOf(SongpickError)
    }
  })

  it('health reports success and failure', async () => {
    const ok = createSongpickClient('http://sp', {
      fetch: vi.fn().mockResolvedValue(new Response('{"status":"ok"}')) as unknown as typeof fetch,
    })
    expect((await ok.health()).success).toBe(true)
    const bad = createSongpickClient('http://sp', {
      fetch: vi
        .fn()
        .mockResolvedValue(new Response('', { status: 500 })) as unknown as typeof fetch,
    })
    expect((await bad.health()).success).toBe(false)
  })
})
