import { timingSafeEqual } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { type ApiKeyScope, hashApiKeySecret } from '@/core/auth/api-keys'
import type { Database } from '@/db'
import { apiKeys } from '../schema'

/**
 * Minimum gap between `last_used_at` writes for a single key, so a polling
 * reader does not turn every authenticated read into a database write.
 */
export const API_KEY_TOUCH_THROTTLE_MS = 60_000

/** Listing shape. Deliberately omits `keyHash` so it cannot leak through a route. */
export type ApiKeyRow = {
  id: number
  userId: number
  name: string
  prefix: string
  scopes: string[]
  createdAt: Date
  lastUsedAt: Date | null
  expiresAt: Date | null
  revokedAt: Date | null
}

const LIST_COLUMNS = {
  id: apiKeys.id,
  userId: apiKeys.userId,
  name: apiKeys.name,
  prefix: apiKeys.prefix,
  scopes: apiKeys.scopes,
  createdAt: apiKeys.createdAt,
  lastUsedAt: apiKeys.lastUsedAt,
  expiresAt: apiKeys.expiresAt,
  revokedAt: apiKeys.revokedAt,
}

/** Constant-time hex-digest comparison. Both operands are fixed-length SHA-256 hex. */
function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function apiKeyQueries(db: Database) {
  return {
    async create(params: {
      userId: number
      name: string
      prefix: string
      keyHash: string
      scopes: ApiKeyScope[]
      expiresAt: Date | null
    }): Promise<ApiKeyRow> {
      const [row] = await db
        .insert(apiKeys)
        .values({
          userId: params.userId,
          name: params.name,
          prefix: params.prefix,
          keyHash: params.keyHash,
          scopes: params.scopes,
          expiresAt: params.expiresAt,
        })
        .returning(LIST_COLUMNS)
      if (!row) throw new Error('Failed to create API key')
      return row
    },

    async verify(
      prefix: string,
      secret: string,
    ): Promise<{ id: number; userId: number; scopes: string[] } | null> {
      if (!prefix || !secret) return null
      const [row] = await db
        .select({
          id: apiKeys.id,
          userId: apiKeys.userId,
          scopes: apiKeys.scopes,
          keyHash: apiKeys.keyHash,
          expiresAt: apiKeys.expiresAt,
        })
        .from(apiKeys)
        .where(and(eq(apiKeys.prefix, prefix), isNull(apiKeys.revokedAt)))
        .limit(1)
      if (!row) return null
      if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null
      if (!hashesMatch(row.keyHash, hashApiKeySecret(secret))) return null
      return { id: row.id, userId: row.userId, scopes: row.scopes }
    },

    async listForUser(userId: number): Promise<ApiKeyRow[]> {
      return db.select(LIST_COLUMNS).from(apiKeys).where(eq(apiKeys.userId, userId))
    },

    async listAll(): Promise<ApiKeyRow[]> {
      return db.select(LIST_COLUMNS).from(apiKeys)
    },

    /** `userId: null` means an admin acting on any key. */
    async revoke(params: { id: number; userId: number | null }): Promise<boolean> {
      const ownership = params.userId === null ? undefined : eq(apiKeys.userId, params.userId)
      const revoked = await db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(
          ownership
            ? and(eq(apiKeys.id, params.id), isNull(apiKeys.revokedAt), ownership)
            : and(eq(apiKeys.id, params.id), isNull(apiKeys.revokedAt)),
        )
        .returning({ id: apiKeys.id })
      return revoked.length === 1
    },

    async touchLastUsed(id: number): Promise<void> {
      await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, id))
    },
  }
}

export type ApiKeyStore = ReturnType<typeof apiKeyQueries>
