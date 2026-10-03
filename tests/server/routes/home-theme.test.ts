// @vitest-environment node
// HW-64 (fork): /api/v1/auth/me/theme
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { HomeThemeState } from '@/core/home-theme'
import { homeThemeRoutes } from '@/server/routes/home-theme'
import type { HonoEnv } from '@/server/types'

function setup(initial: HomeThemeState, authMethod = 'session-cookie') {
  let state = initial
  const deps = {
    loadHomeThemeState: vi.fn(async () => state),
    saveHomeThemeState: vi.fn(async (_id: number, next: HomeThemeState) => {
      state = next
    }),
  }
  const app = new Hono<HonoEnv>()
  app.use('*', async (c, next) => {
    c.set('userId', 2)
    c.set('authMethod', authMethod as never)
    await next()
  })
  app.route('/', homeThemeRoutes(deps))
  const put = (body: unknown) =>
    app.request('/api/v1/auth/me/theme', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  return { app, deps, put, get: () => state }
}

const perApp = { theme: 'ink', mode: 'light' as const, override: 'ink/light' }

describe('home theme routes', () => {
  it('GET returns claim, choice and the effective theme', async () => {
    const { app } = setup({ claim: perApp, choice: null })
    const res = await app.request('/api/v1/auth/me/theme')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      claim: perApp,
      choice: null,
      effective: { source: 'claim', color: 'home:ink', mode: 'light' },
    })
  })

  it('PUT stores the choice with the current override as basis', async () => {
    const { put, get } = setup({ claim: perApp, choice: null })
    const res = await put({ color: 'home:rave', mode: 'dark' })
    expect(res.status).toBe(200)
    expect((await res.json()).effective).toEqual({
      source: 'app',
      color: 'home:rave',
      mode: 'dark',
    })
    expect(get().choice).toEqual({ color: 'home:rave', mode: 'dark', basis: 'ink/light' })
  })

  it('PUT follow clears the choice', async () => {
    const { put, get } = setup({
      claim: perApp,
      choice: { color: 'nord', mode: 'dark', basis: 'ink/light' },
    })
    const res = await put({ follow: true })
    expect((await res.json()).effective.source).toBe('claim')
    expect(get().choice).toBeNull()
  })

  it('rejects bad input and API-key writes', async () => {
    expect(
      (await setup({ claim: null, choice: null }).put({ color: 'a b', mode: 'dark' })).status,
    ).toBe(400)
    expect(
      (await setup({ claim: null, choice: null }).put({ color: 'nord', mode: 'sepia' })).status,
    ).toBe(400)
    const keyed = setup({ claim: null, choice: null }, 'api-key')
    expect((await keyed.put({ follow: true })).status).toBe(403)
    expect(keyed.deps.saveHomeThemeState).not.toHaveBeenCalled()
  })
})
