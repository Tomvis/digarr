// HW-64 (fork): OidcService reads home_theme from the ID token, else userinfo, only when scoped.
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('openid-client', () => ({
  customFetch: Symbol.for('openid-client-custom-fetch'),
  discovery: vi.fn(async () => ({})),
  authorizationCodeGrant: vi.fn(),
  fetchUserInfo: vi.fn(),
}))

import * as oidcClient from 'openid-client'
import { OidcService } from '@/core/auth/oidc'

const claim = { theme: 'dusk', mode: 'dark', override: 'follow' }

async function login(scopes: string, idClaims: Record<string, unknown>) {
  const service = new OidcService({ issuerUrl: 'https://auth.example.com', clientId: 'c', scopes })
  vi.mocked(oidcClient.authorizationCodeGrant).mockResolvedValue({
    claims: () => ({ sub: 'sub-1', ...idClaims }),
    access_token: 'at',
  } as never)
  // biome-ignore lint/complexity/useLiteralKeys: seeding a private pending transaction
  service['pendingAuths'].set('s', {
    nonce: 'n',
    codeVerifier: 'v',
    redirectUri: 'http://localhost/cb',
    createdAt: Date.now(),
    browserBindingHash: createHash('sha256').update('b').digest(),
    purpose: { kind: 'login' },
  })
  const res = await service.handleCallback(new URL('http://localhost/cb?code=x&state=s'), 'b')
  return res.claims.homeTheme
}

describe('OidcService home_theme claim', () => {
  beforeEach(() => vi.clearAllMocks())

  it('ignores the claim unless the home_theme scope is configured', async () => {
    expect(await login('openid profile email', { home_theme: claim })).toBeUndefined()
    expect(oidcClient.fetchUserInfo).not.toHaveBeenCalled()
  })

  it('reads it from the ID token', async () => {
    expect(await login('openid profile email home_theme', { home_theme: claim })).toEqual(claim)
    expect(oidcClient.fetchUserInfo).not.toHaveBeenCalled()
  })

  it('falls back to userinfo, and a userinfo failure is not a login failure', async () => {
    vi.mocked(oidcClient.fetchUserInfo).mockResolvedValueOnce({ sub: 'sub-1', home_theme: claim })
    expect(await login('openid home_theme', {})).toEqual(claim)
    vi.mocked(oidcClient.fetchUserInfo).mockRejectedValueOnce(new Error('boom'))
    expect(await login('openid home_theme', {})).toBeUndefined()
  })
})
