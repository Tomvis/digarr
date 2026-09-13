import type { Context } from 'hono'
import {
  adminRequired,
  notAuthenticated,
  sessionAuthRequired,
} from '@/server/helpers/auth-problems'
import { resolveAdmin } from '@/server/middleware/admin-guard'
import type { HonoEnv } from '@/server/types'

// Shared session/admin gate helpers. Every route file was re-implementing the
// same three gates with tiny drift; centralising here keeps the error copy
// and legacy-token handling consistent across the API.

type GetUserById = (id: number) => Promise<{ isAdmin: boolean } | null>

export type RequireUserResult = { ok: true; userId: number } | { ok: false; response: Response }

/** Caller is authenticated (session OR legacy token). Does not enforce session-only. */
export function requireUser(c: Context<HonoEnv>): RequireUserResult {
  const userId = c.get('userId')
  if (!userId) {
    return { ok: false, response: notAuthenticated(c) }
  }
  return { ok: true, userId }
}

/**
 * Caller is authenticated by a real session. Rejects legacy-token auth
 * (userId=1) and API key auth: keys are scope-limited credentials, not a
 * stand-in for a session, and must not satisfy checks that mean "a real
 * session" (e.g. the key-management routes, or a key could mint another key).
 */
export function requireSessionUser(c: Context<HonoEnv>): RequireUserResult {
  const auth = requireUser(c)
  if (!auth.ok) return auth
  if (c.get('legacyTokenAuth') || c.get('authMethod') === 'api-key') {
    return { ok: false, response: sessionAuthRequired(c) }
  }
  return auth
}

/** Caller is an admin. Honours authSkipped (fresh install) and rejects legacy tokens. */
export async function requireAdmin(
  c: Context<HonoEnv>,
  getUserById: GetUserById,
): Promise<RequireUserResult> {
  if (c.get('authSkipped')) {
    return { ok: true, userId: c.get('userId') ?? 0 }
  }
  const auth = requireUser(c)
  if (!auth.ok) return auth
  const isAdmin = await resolveAdmin(
    auth.userId,
    getUserById,
    false,
    c.get('legacyTokenAuth'),
    c.get('authMethod'),
    c.get('apiKeyScopes'),
  )
  if (!isAdmin) {
    return { ok: false, response: adminRequired(c) }
  }
  return auth
}
