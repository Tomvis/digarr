// @vitest-environment node

import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { requireSessionUser } from '@/server/helpers/require-user'
import { adminGuard, resolveAdmin } from '@/server/middleware/admin-guard'
import { scopeGuard } from '@/server/middleware/scope-guard'
import type { AuthMethod, HonoEnv } from '@/server/types'

function appAs(
  authMethod: AuthMethod,
  scopes: string[] | undefined,
  mount: (app: Hono<HonoEnv>) => void,
) {
  const app = new Hono<HonoEnv>()
  app.use('*', async (c, next) => {
    c.set('userId', 1)
    c.set('authMethod', authMethod)
    if (scopes) c.set('apiKeyScopes', scopes)
    await next()
  })
  mount(app)
  return app
}

const adminUser = vi.fn(async () => ({ isAdmin: true }))

describe('scopeGuard', () => {
  it('admits an api key carrying the required scope', async () => {
    const app = appAs('api-key', ['write'], (a) => {
      a.use('/w', scopeGuard('write'))
      a.post('/w', (c) => c.json({ ok: true }))
    })
    expect((await app.request('/w', { method: 'POST' })).status).toBe(200)
  })

  it('refuses an api key that lacks it', async () => {
    const app = appAs('api-key', ['read'], (a) => {
      a.use('/w', scopeGuard('write'))
      a.post('/w', (c) => c.json({ ok: true }))
    })
    expect((await app.request('/w', { method: 'POST' })).status).toBe(403)
  })

  it('leaves session auth unscoped', async () => {
    const app = appAs('session-bearer', undefined, (a) => {
      a.use('/w', scopeGuard('admin'))
      a.post('/w', (c) => c.json({ ok: true }))
    })
    expect((await app.request('/w', { method: 'POST' })).status).toBe(200)
  })
})

describe('adminGuard with api keys', () => {
  it('refuses an ADMIN user whose key lacks the admin scope', async () => {
    const app = appAs('api-key', ['write'], (a) => {
      a.use('/a', adminGuard(adminUser))
      a.get('/a', (c) => c.json({ ok: true }))
    })
    expect((await app.request('/a')).status).toBe(403)
  })

  it('admits an admin user whose key carries the admin scope', async () => {
    const app = appAs('api-key', ['admin'], (a) => {
      a.use('/a', adminGuard(adminUser))
      a.get('/a', (c) => c.json({ ok: true }))
    })
    expect((await app.request('/a')).status).toBe(200)
  })

  it('refuses a NON-admin user whose key carries the admin scope', async () => {
    const app = appAs('api-key', ['admin'], (a) => {
      a.use('/a', adminGuard(vi.fn(async () => ({ isAdmin: false }))))
      a.get('/a', (c) => c.json({ ok: true }))
    })
    expect((await app.request('/a')).status).toBe(403)
  })

  it('resolveAdmin agrees with adminGuard for a scoped key', async () => {
    expect(await resolveAdmin(1, adminUser, false, false, 'api-key', ['write'])).toBe(false)
    expect(await resolveAdmin(1, adminUser, false, false, 'api-key', ['admin'])).toBe(true)
  })
})

describe('requireSessionUser', () => {
  it('rejects api-key auth, not just legacy tokens', async () => {
    const app = appAs('api-key', ['admin'], (a) => {
      a.get('/s', (c) => {
        const auth = requireSessionUser(c)
        return auth.ok ? c.json({ ok: true }) : auth.response
      })
    })
    expect((await app.request('/s')).status).toBe(403)
  })

  it('still admits a real session', async () => {
    const app = appAs('session-bearer', undefined, (a) => {
      a.get('/s', (c) => {
        const auth = requireSessionUser(c)
        return auth.ok ? c.json({ ok: true }) : auth.response
      })
    })
    expect((await app.request('/s')).status).toBe(200)
  })
})
