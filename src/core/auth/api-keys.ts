import { createHash, randomBytes } from 'node:crypto'

/**
 * Ordered scopes. Each implies every scope below it, which mirrors the two
 * access levels digarr already enforces (authenticated, admin) instead of
 * introducing a resource taxonomy the project would have to live with.
 */
export const API_KEY_SCOPES = ['read', 'write', 'admin'] as const
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number]

export const API_KEY_TOKEN_PREFIX = 'dgr_'

/** Public, indexed lookup handle. Not a secret. */
const PREFIX_BYTES = 4
/** 256 bits of CSPRNG material. Full entropy, so a plain digest is sufficient. */
const SECRET_BYTES = 32

const SCOPE_RANK: Record<ApiKeyScope, number> = { read: 0, write: 1, admin: 2 }

function isScope(value: string): value is ApiKeyScope {
  return value in SCOPE_RANK
}

/**
 * Hash a key secret before storage or lookup so plaintext secrets never touch
 * the DB. Mirrors `hashSessionToken`. A password KDF would be wrong here: the
 * secret is already full-entropy, so stretching buys no brute-force resistance
 * and costs a stretch on every authenticated request.
 */
export function hashApiKeySecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

export function generateApiKey(): { token: string; prefix: string; keyHash: string } {
  const prefix = randomBytes(PREFIX_BYTES).toString('hex')
  const secret = randomBytes(SECRET_BYTES).toString('base64url')
  return {
    token: `${API_KEY_TOKEN_PREFIX}${prefix}_${secret}`,
    prefix,
    keyHash: hashApiKeySecret(secret),
  }
}

export function isApiKeyToken(token: string): boolean {
  return token.startsWith(API_KEY_TOKEN_PREFIX)
}

export function parseApiKey(token: string): { prefix: string; secret: string } | null {
  if (!isApiKeyToken(token)) return null
  const body = token.slice(API_KEY_TOKEN_PREFIX.length)
  const separator = body.indexOf('_')
  if (separator <= 0) return null
  const prefix = body.slice(0, separator)
  // Split on the FIRST separator only: base64url excludes '_' but a malformed
  // or future token must not silently lose secret material to a greedy split.
  const secret = body.slice(separator + 1)
  if (!prefix || !secret) return null
  return { prefix, secret }
}

export function parseScopes(raw: readonly string[]): ApiKeyScope[] {
  const known = new Set(raw.filter(isScope))
  return API_KEY_SCOPES.filter((scope) => known.has(scope))
}

export function scopeSatisfies(granted: readonly string[], required: ApiKeyScope): boolean {
  const needed = SCOPE_RANK[required]
  return granted.some((scope) => isScope(scope) && SCOPE_RANK[scope] >= needed)
}
