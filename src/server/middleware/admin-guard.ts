import { createMiddleware } from 'hono/factory'
import { scopeSatisfies } from '@/core/auth/api-keys'
import { adminRequired } from '@/server/helpers/auth-problems'
import type { AuthMethod, HonoEnv } from '@/server/types'

type GetUserById = (id: number) => Promise<{ isAdmin: boolean } | null>

/**
 * Middleware that rejects non-admin users with 403.
 * Delegates the actual verdict to `resolveAdmin` so the two can never drift:
 * legacy token auth (no userId) is NOT admin, authSkipped (fresh installs) is
 * allowed through because the setup guard already blocks non-setup API paths,
 * and an api-key auth without the 'admin' scope is refused even for an admin
 * user -- scope narrows, it never grants.
 */
export function adminGuard(getUserById: GetUserById) {
  return createMiddleware<HonoEnv>(async (c, next) => {
    const isAdmin = await resolveAdmin(
      c.get('userId'),
      getUserById,
      c.get('authSkipped'),
      c.get('legacyTokenAuth'),
      c.get('authMethod'),
      c.get('apiKeyScopes'),
    )
    if (!isAdmin) return adminRequired(c)
    await next()
  })
}

/**
 * Single source of truth for "is this caller an admin", used both as the
 * inline check for routes that need the isAdmin boolean for branching, and
 * as the decision `adminGuard` delegates to. authSkipped (fresh installs)
 * grants admin because the setup guard already blocks non-setup paths when
 * setup is not complete. `getUserById` is never called on a short-circuit
 * path (authSkipped / legacyTokenAuth / unscoped api-key / missing userId).
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
