// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createTestApp } from '../helpers/test-app'

const getSession = vi.fn(async (_token: string) => ({
  userId: 1,
  token: 'tok',
  expiresAt: new Date(Date.now() + 86400000),
}))

vi.mock('@/core/sessions', () => ({ getSession: (t: string) => getSession(t) }))

const AUTH = { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    userId: 1,
    name: 'Music Assistant',
    prefix: 'ab12cd34',
    scopes: ['read', 'write'],
    createdAt: new Date(),
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  }
}

describe('POST /api/v1/api-keys', () => {
  it('returns the plaintext token exactly once, and never stores it', async () => {
    const create = vi.fn(async (p: { keyHash: string }) => {
      // The route must hand the store a HASH, never the secret itself.
      expect(p.keyHash).toMatch(/^[0-9a-f]{64}$/)
      return row()
    })
    const { app } = createTestApp({
      apiKeyStore: { create, listForUser: vi.fn(async () => [row()]) } as never,
    })

    const res = await app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ name: 'Music Assistant', scopes: ['read', 'write'] }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.token).toMatch(/^dgr_/)
    expect(body.key).not.toHaveProperty('keyHash')

    const listed = await (await app.request('/api/v1/api-keys', { headers: AUTH })).text()
    expect(listed).not.toContain(body.token)
  })

  it('rejects unknown scopes', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ name: 'bad', scopes: ['superuser'] }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects an expiry that is already in the past', async () => {
    // Otherwise the response is a 201 carrying a plaintext secret for a key
    // that fails every request it is ever used on.
    const create = vi.fn(async () => row())
    const { app } = createTestApp({ apiKeyStore: { create } as never })
    const res = await app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        name: 'dead on arrival',
        scopes: ['read'],
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'validation_failed' })
    expect(create).not.toHaveBeenCalled()
  })

  it('accepts an expiry in the future', async () => {
    const create = vi.fn(async () => row())
    const { app } = createTestApp({ apiKeyStore: { create } as never })
    const res = await app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        name: 'valid',
        scopes: ['read'],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    })
    expect(res.status).toBe(201)
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: expect.any(Date) }))
  })

  it('rejects an empty scope list', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ name: 'bad', scopes: [] }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects duplicate scopes', async () => {
    const create = vi.fn(async () => row())
    const { app } = createTestApp({ apiKeyStore: { create } as never })
    const res = await app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ name: 'bad', scopes: ['read', 'read'] }),
    })
    expect(res.status).toBe(400)
    expect(create).not.toHaveBeenCalled()
  })

  it('cannot be called with an API key, only a session', async () => {
    // No need to touch the `getSession` mock: a `dgr_`-prefixed bearer token is
    // recognised as an API key by authGuard and authenticated on that branch
    // entirely, never falling through to the session lookup. (A stray
    // `mockResolvedValueOnce` here would go unconsumed and leak into whichever
    // later test calls `getSession` next.)
    const { app } = createTestApp({
      apiKeyStore: {
        verify: vi.fn(async () => ({ id: 5, userId: 1, scopes: ['admin'] })),
        touchLastUsed: vi.fn(async () => {}),
        create: vi.fn(async () => row()),
      } as never,
    })
    const res = await app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: { Authorization: 'Bearer dgr_ab12cd34_secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'escalate', scopes: ['admin'] }),
    })
    expect(res.status).toBe(403)
  })
})

describe('GET /api/v1/api-keys', () => {
  it('scopes the listing to the caller', async () => {
    const listForUser = vi.fn(async () => [row()])
    const { app } = createTestApp({ apiKeyStore: { listForUser } as never })
    const res = await app.request('/api/v1/api-keys', { headers: AUTH })
    expect(res.status).toBe(200)
    expect(listForUser).toHaveBeenCalledWith(1)
  })

  it('never includes a hash', async () => {
    const { app } = createTestApp({
      apiKeyStore: { listForUser: vi.fn(async () => [row()]) } as never,
    })
    const raw = await (await app.request('/api/v1/api-keys', { headers: AUTH })).text()
    expect(raw).not.toContain('keyHash')
    expect(raw).not.toContain('key_hash')
  })
})

describe('DELETE /api/v1/api-keys/:id', () => {
  it("revokes the caller's own key", async () => {
    const revoke = vi.fn(async () => true)
    const { app } = createTestApp({ apiKeyStore: { revoke } as never })
    const res = await app.request('/api/v1/api-keys/10', { method: 'DELETE', headers: AUTH })
    expect(res.status).toBe(204)
    expect(revoke).toHaveBeenCalledWith({ id: 10, userId: 1 })
  })

  it('reports 404, not 403, for a key belonging to someone else', async () => {
    const { app } = createTestApp({
      apiKeyStore: { revoke: vi.fn(async () => false) } as never,
    })
    const res = await app.request('/api/v1/api-keys/10', { method: 'DELETE', headers: AUTH })
    expect(res.status).toBe(404)
  })
})
