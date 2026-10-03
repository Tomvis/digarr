// @vitest-environment node
// HW-64 (fork): the OIDC callback stores the home_theme claim and never fails login on it.
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OidcService } from '@/core/auth/oidc'
import { clearAllSessions } from '@/core/sessions'
import { oidcRoutes } from '@/server/routes/oidc'
import type { HonoEnv } from '@/server/types'

vi.mock('@/config/env', () => ({ envConfig: { allowedOrigin: 'http://localhost:3000' } }))
vi.mock('@/core/auth', () => ({
  generateSessionToken: vi.fn(() => 'session-token'),
  hashPassword: vi.fn(() => 'hash'),
  verifyPassword: vi.fn(() => true),
}))

const claim = { theme: 'dusk', mode: 'dark', override: 'follow' }

function app(recordHomeThemeClaim: (id: number, c: unknown) => Promise<void>) {
  const oidc = {
    handleCallback: vi.fn(async () => ({
      purpose: { kind: 'login' as const },
      claims: { sub: 'sub-1', preferredUsername: 'lera', homeTheme: claim },
    })),
  }
  const a = new Hono<HonoEnv>()
  a.route(
    '/',
    oidcRoutes({
      getOidcService: async () => oidc as unknown as OidcService,
      getUserByOidcSubject: async () => ({ id: 2, username: 'lera' }),
      getUserByUsername: async () => null,
      getUserCredentialsById: async () => null,
      createUser: vi.fn(),
      linkOidcIdentity: vi.fn(),
      recordHomeThemeClaim,
    }),
  )
  return a
}

afterEach(async () => {
  await clearAllSessions()
})

describe('OIDC callback home theme', () => {
  it('records the claim for the signed-in user', async () => {
    const record = vi.fn(async () => {})
    const res = await app(record).request('/api/v1/auth/oidc/callback?state=abc&code=x')
    expect(res.headers.get('Location')).toBe('/')
    expect(record).toHaveBeenCalledWith(2, claim)
  })

  it('still signs in when storing the claim fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await app(async () => {
      throw new Error('db down')
    }).request('/api/v1/auth/oidc/callback?state=abc&code=x')
    expect(res.headers.get('Location')).toBe('/')
    expect(res.headers.get('set-cookie')).toContain('digarr_session=session-token')
    warn.mockRestore()
  })
})
