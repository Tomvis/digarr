// @vitest-environment node

// End-to-end proof that the write scope is actually ENFORCED, not merely
// implemented. `scopeGuard` existed, was unit-tested, and was mounted by
// nothing -- so a key created with the UI's default `['read']` could approve,
// unapprove, reject and bulk-mutate. These tests go through the real app
// (createApp), which is the only place that can catch that again.

import { describe, expect, it, vi } from 'vitest'
import type { AppDependencies } from '@/server'
import { makeRecommendation } from '../helpers/factories'
import { createTestApp } from '../helpers/test-app'

const getSession = vi.fn(async (_token: string) => ({
  userId: 1,
  token: 'tok',
  expiresAt: new Date(Date.now() + 86400000),
}))

vi.mock('@/core/sessions', () => ({ getSession: (t: string) => getSession(t) }))

const JSON_HEADER = { 'Content-Type': 'application/json' }
const KEY_AUTH = { Authorization: 'Bearer dgr_ab12cd34_secret', ...JSON_HEADER }
const SESSION_AUTH = { Authorization: 'Bearer tok', ...JSON_HEADER }

function appWithKeyScopes(scopes: string[], overrides: Partial<AppDependencies> = {}) {
  return createTestApp({
    apiKeyStore: {
      verify: vi.fn(async () => ({ id: 5, userId: 1, scopes })),
      touchLastUsed: vi.fn(async () => {}),
      listForUser: vi.fn(async () => []),
    } as never,
    getRecommendation: vi.fn(async () =>
      makeRecommendation({ id: 1, userId: 1, status: 'approved', lidarrArtistId: null }),
    ) as never,
    listRecommendations: vi.fn(async () => ({ items: [], total: 0 })),
    ...overrides,
  }).app
}

const patchRecommendation = (app: ReturnType<typeof appWithKeyScopes>, headers: HeadersInit) =>
  app.request('/api/v1/recommendations/1', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ status: 'pending' }),
  })

describe('write-scope enforcement on mutating requests', () => {
  it('refuses a read-scoped key on a mutating request', async () => {
    const updateRecommendationStatus = vi.fn(async () => {})
    const app = appWithKeyScopes(['read'], { updateRecommendationStatus })

    const res = await patchRecommendation(app, KEY_AUTH)

    expect(res.status).toBe(403)
    expect(res.headers.get('content-type')).toContain('application/problem+json')
    expect(await res.json()).toMatchObject({
      type: '/problems/insufficient-scope',
      status: 403,
      code: 'errors.auth.insufficientScope',
    })
    // Fail-closed: the handler never ran.
    expect(updateRecommendationStatus).not.toHaveBeenCalled()
  })

  it('admits a write-scoped key on the same request', async () => {
    const updateRecommendationStatus = vi.fn(async () => {})
    const app = appWithKeyScopes(['write'], { updateRecommendationStatus })

    const res = await patchRecommendation(app, KEY_AUTH)

    expect(res.status).toBe(200)
    expect(updateRecommendationStatus).toHaveBeenCalled()
  })

  it('admits an admin-scoped key (admin implies write)', async () => {
    const app = appWithKeyScopes(['admin'])
    expect((await patchRecommendation(app, KEY_AUTH)).status).toBe(200)
  })

  it('leaves reads alone for a read-scoped key', async () => {
    const app = appWithKeyScopes(['read'])
    const res = await app.request('/api/v1/recommendations', { headers: KEY_AUTH })
    expect(res.status).toBe(200)
  })

  it('is global, not per-route: a second mutating route is covered too', async () => {
    const app = appWithKeyScopes(['read'])
    const res = await app.request('/api/v1/recommendations/bulk', {
      method: 'POST',
      headers: KEY_AUTH,
      body: JSON.stringify({ ids: [1], action: 'reject' }),
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ type: '/problems/insufficient-scope' })
  })

  it('leaves session auth entirely unscoped', async () => {
    const updateRecommendationStatus = vi.fn(async () => {})
    const app = appWithKeyScopes(['read'], { updateRecommendationStatus })

    const res = await patchRecommendation(app, SESSION_AUTH)

    expect(res.status).toBe(200)
    expect(updateRecommendationStatus).toHaveBeenCalled()
  })

  it('leaves non-api paths alone', async () => {
    const app = appWithKeyScopes(['read'])
    // /health is outside /api/v1/, so the gate must not intercept it.
    expect((await app.request('/health', { headers: KEY_AUTH })).status).toBe(200)
  })
})
