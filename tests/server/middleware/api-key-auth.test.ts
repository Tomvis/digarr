// @vitest-environment node

import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateApiKey } from '@/core/auth/api-keys'
import { authGuard } from '@/server/middleware/auth'
import type { HonoEnv } from '@/server/types'

function appWith(verify: ReturnType<typeof vi.fn>, touchLastUsed = vi.fn(async () => {})) {
  const app = new Hono<HonoEnv>()
  app.use(
    '*',
    authGuard({
      hasUsers: async () => true,
      isSetupComplete: async () => true,
      apiKeys: { verify, touchLastUsed } as never,
    }),
  )
  app.get('/api/v1/recommendations', (c) =>
    c.json({
      userId: c.get('userId'),
      authMethod: c.get('authMethod'),
      scopes: c.get('apiKeyScopes'),
    }),
  )
  return app
}

describe('authGuard api-key branch', () => {
  it('authenticates a valid key and exposes its scopes', async () => {
    const { token } = generateApiKey()
    const verify = vi.fn(async () => ({ id: 7, userId: 2, scopes: ['read', 'write'] }))
    const res = await appWith(verify).request('/api/v1/recommendations', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      userId: 2,
      authMethod: 'api-key',
      scopes: ['read', 'write'],
    })
  })

  it('rejects an unknown or revoked key with 401', async () => {
    const { token } = generateApiKey()
    const verify = vi.fn(async () => null)
    const res = await appWith(verify).request('/api/v1/recommendations', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(401)
  })

  it('never accepts an api key as a query parameter', async () => {
    const { token } = generateApiKey()
    const verify = vi.fn(async () => ({ id: 7, userId: 2, scopes: ['admin'] }))
    const res = await appWith(verify).request(
      `/api/v1/pipeline/events?token=${encodeURIComponent(token)}`,
    )
    expect(res.status).toBe(401)
    expect(verify).not.toHaveBeenCalled()
  })

  it('throttles last-used writes to one per key per minute', async () => {
    const { token } = generateApiKey()
    // Distinct key id from the other tests: the throttle map is module-level
    // (by design, to survive across requests for the same real key), so
    // reusing id 7 here would inherit the touch timestamp the first test
    // already recorded for that id and make every call in this test throttled.
    const verify = vi.fn(async () => ({ id: 99, userId: 2, scopes: ['read'] }))
    const touch = vi.fn(async () => {})
    const app = appWith(verify, touch)
    const headers = { Authorization: `Bearer ${token}` }
    await app.request('/api/v1/recommendations', { headers })
    await app.request('/api/v1/recommendations', { headers })
    await app.request('/api/v1/recommendations', { headers })
    expect(touch).toHaveBeenCalledTimes(1)
  })

  it('logs a warning when the last-used write fails, instead of swallowing it', async () => {
    const { token } = generateApiKey()
    const verify = vi.fn(async () => ({ id: 123, userId: 2, scopes: ['read'] }))
    const touch = vi.fn(async () => {
      throw new Error('db unavailable')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const app = appWith(verify, touch)
      const res = await app.request('/api/v1/recommendations', {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(200)
      // The touch failure is fire-and-forget; give its rejection a tick to settle.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('last_used_at'),
        expect.any(Error),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('does not consult the session store for a dgr_ token', async () => {
    const { token } = generateApiKey()
    const verify = vi.fn(async () => ({ id: 1, userId: 1, scopes: ['read'] }))
    const res = await appWith(verify).request('/api/v1/recommendations', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    expect(verify).toHaveBeenCalledTimes(1)
  })

  describe('with a configured legacy token', () => {
    afterEach(() => {
      delete process.env.DIGARR_AUTH_TOKEN
    })

    it('does not fall through to DIGARR_AUTH_TOKEN when the presented key is invalid', async () => {
      const { token } = generateApiKey()
      // Deliberately make the legacy token equal to the (invalid) API key
      // token, so a buggy implementation that fell through to the legacy
      // check would authenticate the request via safeCompare.
      process.env.DIGARR_AUTH_TOKEN = token
      vi.resetModules()
      const { authGuard: freshAuthGuard } = await import('@/server/middleware/auth')

      const verify = vi.fn(async () => null)
      const app = new Hono<HonoEnv>()
      app.use(
        '*',
        freshAuthGuard({
          hasUsers: async () => true,
          isSetupComplete: async () => true,
          apiKeys: { verify, touchLastUsed: vi.fn(async () => {}) } as never,
        }),
      )
      app.get('/api/v1/recommendations', (c) =>
        c.json({ authMethod: c.get('authMethod'), legacyTokenAuth: c.get('legacyTokenAuth') }),
      )

      const res = await app.request('/api/v1/recommendations', {
        headers: { Authorization: `Bearer ${token}` },
      })

      expect(res.status).toBe(401)
      expect(verify).toHaveBeenCalledTimes(1)
    })
  })
})
