import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>()
  return {
    ...actual,
    lookup: vi.fn(),
  }
})

vi.mock('openid-client', () => ({
  customFetch: Symbol.for('openid-client-custom-fetch'),
  discovery: vi.fn(),
  buildAuthorizationUrl: vi.fn(),
  authorizationCodeGrant: vi.fn(),
  randomState: vi.fn(() => 'mock-state'),
  randomNonce: vi.fn(() => 'mock-nonce'),
  randomPKCECodeVerifier: vi.fn(() => 'mock-code-verifier'),
  calculatePKCECodeChallenge: vi.fn(async () => 'mock-code-challenge'),
}))

vi.mock('@/config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/env')>()
  return {
    ...actual,
    envConfig: {
      ...actual.envConfig,
      // Only this exact host is exempted from the private-IP guard.
      oidcAllowPrivateIssuerHosts: 'authentik.leratom.cloud',
    },
  }
})

import * as dns from 'node:dns/promises'
import * as oidcClient from 'openid-client'
import { OidcService } from '@/core/auth/oidc'

const config = {
  issuerUrl: 'https://authentik.leratom.cloud/application/o/digarr/',
  clientId: 'test-client',
  clientSecret: 'test-secret',
  scopes: 'openid profile email',
}

/** Drive a discovery call and hand back the customFetch openid-client received. */
async function captureCustomFetch(service: OidcService) {
  vi.mocked(oidcClient.discovery).mockResolvedValue({} as never)
  vi.mocked(oidcClient.buildAuthorizationUrl).mockReturnValue(
    new URL('https://authentik.leratom.cloud/authorize?state=mock-state'),
  )
  await service.getAuthorizationUrl('https://digarr.example.com/api/v1/auth/oidc/callback', {
    kind: 'login',
  })

  const options = vi.mocked(oidcClient.discovery).mock.calls[0]?.[4]
  const customFetch = options?.[oidcClient.customFetch] as
    | ((url: string, init: RequestInit) => Promise<Response>)
    | undefined
  expect(customFetch).toBeDefined()
  return customFetch as (url: string, init: RequestInit) => Promise<Response>
}

describe('OIDC private-issuer allowlist', () => {
  let service: OidcService

  beforeEach(() => {
    vi.clearAllMocks()
    service = new OidcService(config)
  })

  it('allows an allowlisted issuer host that resolves to a private IP', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(dns.lookup).mockResolvedValue({ address: '10.0.0.253', family: 4 } as never)

    const customFetch = await captureCustomFetch(service)

    await expect(
      customFetch('https://authentik.leratom.cloud/.well-known/openid-configuration', {
        headers: {},
      }),
    ).resolves.toBeInstanceOf(Response)

    // Still pinned to the resolved address, with the original host preserved
    // for routing and SNI -- the allowlist relaxes the rejection, not the pinning.
    const [calledUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(calledUrl).toContain('10.0.0.253')
    expect(new Headers(init.headers).get('Host')).toBe('authentik.leratom.cloud')

    vi.unstubAllGlobals()
  })

  it('still rejects a NON-allowlisted host that resolves to a private IP', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(dns.lookup).mockResolvedValue({ address: '10.0.0.253', family: 4 } as never)

    const customFetch = await captureCustomFetch(service)

    await expect(
      customFetch('https://evil.example.com/.well-known/openid-configuration', { headers: {} }),
    ).rejects.toThrow('OIDC issuer resolves to a private/internal IP')
    expect(fetchMock).not.toHaveBeenCalled()

    vi.unstubAllGlobals()
  })

  it('does not allow a subdomain of an allowlisted host (no wildcard matching)', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(dns.lookup).mockResolvedValue({ address: '10.0.0.253', family: 4 } as never)

    const customFetch = await captureCustomFetch(service)

    await expect(
      customFetch('https://evil.authentik.leratom.cloud/.well-known/openid-configuration', {
        headers: {},
      }),
    ).rejects.toThrow('OIDC issuer resolves to a private/internal IP')

    vi.unstubAllGlobals()
  })

  it('leaves public-IP issuers unaffected', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(dns.lookup).mockResolvedValue({ address: '93.184.216.34', family: 4 } as never)

    const customFetch = await captureCustomFetch(service)

    await expect(
      customFetch('https://public.example.com/.well-known/openid-configuration', { headers: {} }),
    ).resolves.toBeInstanceOf(Response)

    vi.unstubAllGlobals()
  })
})
