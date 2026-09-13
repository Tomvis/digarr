// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  API_KEY_SCOPES,
  generateApiKey,
  hashApiKeySecret,
  isApiKeyToken,
  parseApiKey,
  parseScopes,
  scopeSatisfies,
} from '@/core/auth/api-keys'

describe('generateApiKey', () => {
  it('mints a dgr_-prefixed token whose parts round-trip', () => {
    const { token, prefix, keyHash } = generateApiKey()
    expect(token.startsWith('dgr_')).toBe(true)

    const parsed = parseApiKey(token)
    expect(parsed).not.toBeNull()
    expect(parsed?.prefix).toBe(prefix)
    expect(hashApiKeySecret(parsed?.secret ?? '')).toBe(keyHash)
  })

  it('never returns the secret inside the stored hash', () => {
    const { token, keyHash } = generateApiKey()
    const secret = parseApiKey(token)?.secret ?? ''
    expect(secret.length).toBeGreaterThan(20)
    expect(keyHash).not.toContain(secret)
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is unique across mints', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateApiKey().token))
    expect(tokens.size).toBe(50)
  })
})

describe('parseApiKey', () => {
  it('rejects tokens that are not api keys', () => {
    expect(parseApiKey('')).toBeNull()
    expect(parseApiKey('sessiontoken')).toBeNull()
    expect(parseApiKey('dgr_')).toBeNull()
    expect(parseApiKey('dgr_onlyprefix')).toBeNull()
    expect(parseApiKey('dgr__emptyprefix')).toBeNull()
  })

  it('does not split on extra underscores inside the secret', () => {
    const { token, prefix } = generateApiKey()
    const parsed = parseApiKey(`${token}_tail`)
    expect(parsed?.prefix).toBe(prefix)
    expect(parsed?.secret.endsWith('_tail')).toBe(true)
  })
})

describe('isApiKeyToken', () => {
  it('recognises api-key tokens without parsing them', () => {
    expect(isApiKeyToken(generateApiKey().token)).toBe(true)
    expect(isApiKeyToken('some-session-token')).toBe(false)
  })
})

describe('scopeSatisfies', () => {
  it('treats scopes as ordered, each implying the ones below', () => {
    expect(scopeSatisfies(['admin'], 'read')).toBe(true)
    expect(scopeSatisfies(['admin'], 'write')).toBe(true)
    expect(scopeSatisfies(['admin'], 'admin')).toBe(true)
    expect(scopeSatisfies(['write'], 'read')).toBe(true)
    expect(scopeSatisfies(['write'], 'write')).toBe(true)
    expect(scopeSatisfies(['read'], 'read')).toBe(true)
  })

  it('never grants upward', () => {
    expect(scopeSatisfies(['read'], 'write')).toBe(false)
    expect(scopeSatisfies(['read'], 'admin')).toBe(false)
    expect(scopeSatisfies(['write'], 'admin')).toBe(false)
  })

  it('ignores unknown scopes and empty grants', () => {
    expect(scopeSatisfies([], 'read')).toBe(false)
    expect(scopeSatisfies(['nonsense'], 'read')).toBe(false)
    expect(scopeSatisfies(['nonsense', 'write'], 'read')).toBe(true)
  })
})

describe('parseScopes', () => {
  it('keeps known scopes in canonical order and drops the rest', () => {
    expect(parseScopes(['write', 'read'])).toEqual(['read', 'write'])
    expect(parseScopes(['bogus'])).toEqual([])
    expect(parseScopes(['admin', 'admin'])).toEqual(['admin'])
  })
})

describe('API_KEY_SCOPES', () => {
  it('is exactly the three ordered scopes', () => {
    expect([...API_KEY_SCOPES]).toEqual(['read', 'write', 'admin'])
  })
})
