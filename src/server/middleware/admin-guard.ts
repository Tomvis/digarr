import { createMiddleware } from 'hono/factory'
import { scopeSatisfies } from '@/core/auth/api-keys'
import { adminRequired } from '@/server/helpers/auth-problems'
import type { AuthMethod, HonoEnv } from '@/server/types'

type GetUserById = (id: number) => Promise<{ isAdmin: boolean } | null>

/**
 * Middleware that rejects non-admin users with 403.
 * Legacy token auth (no userId) is NOT admin - users should migrate to session auth.
 * authSkipped (fresh installs) is allowed through because the setup guard already
 * blocks non-setup API paths when setup is not complete.
 * API key auth is scope-limited: an admin user presenting a key without the
 * 'admin' scope is still refused -- scope narrows, it never grants.
 */
export function adminGuard(getUserById: GetUserById) {
  return createMiddleware<HonoEnv>(async (c, next) => {
    if (c.get('authSkipped')) return next()
    if (c.get('legacyTokenAuth')) return adminRequired(c)
    if (
      c.get('authMethod') === 'api-key' &&
      !scopeSatisfies(c.get('apiKeyScopes') ?? [], 'admin')
    ) {
      return adminRequired(c)
    }
    const uid = c.get('userId')
    if (!uid) return adminRequired(c)
    const u = await getUserById(uid)
    if (!u?.isAdmin) return adminRequired(c)
    await next()
  })
}

/**
 * Inline admin check for routes that need the isAdmin boolean for branching.
 * authSkipped (fresh installs) grants admin because the setup guard already
 * blocks non-setup paths when setup is not complete.
 * Mirrors adminGuard's api-key scope check so the two verdicts cannot drift.
 */
export async function resolveAdmin(
  userId: number | undefined,
  getUserById: GetUserById,
  authSkipped?: boolean,
  legacyTokenAuth?: boolean,
  authMethod?: AuthMethod,
  apiKeyScopes?: string[],
): Promise<boolean> {
  if (authSkipped) return true
  if (legacyTokenAuth) return false
  if (authMethod === 'api-key' && !scopeSatisfies(apiKeyScopes ?? [], 'admin')) return false
  if (!userId) return false
  const user = await getUserById(userId)
  return user?.isAdmin ?? false
}
