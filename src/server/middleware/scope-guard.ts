import { createMiddleware } from 'hono/factory'
import { type ApiKeyScope, scopeSatisfies } from '@/core/auth/api-keys'
import { insufficientScope } from '@/server/helpers/auth-problems'
import type { HonoEnv } from '@/server/types'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Narrow what an API key may do. Session, cookie and proxy auth carry the
 * user's full rights and are deliberately unscoped -- a scope never grants
 * access, it only withholds it from a key.
 */
export function scopeGuard(required: ApiKeyScope) {
  return createMiddleware<HonoEnv>(async (c, next) => {
    if (c.get('authMethod') !== 'api-key') return next()
    if (scopeSatisfies(c.get('apiKeyScopes') ?? [], required)) return next()
    return insufficientScope(c, required)
  })
}

const requireWriteScope = scopeGuard('write')

/**
 * The global write gate, mounted once in `src/server/index.ts` next to
 * `csrfGuard` and shaped the same way: every non-safe method on an
 * `/api/v1/` path requires the `write` scope from an API key.
 *
 * Deliberately global rather than per-route. Annotating individual mutating
 * routes means every future route has to remember to opt in, and the one that
 * forgets is silently unenforced -- which is exactly how a `read` key was able
 * to approve, unapprove, reject and write settings on this branch. Mounted
 * here, a new mutating route is covered the moment it exists.
 *
 * Non-api-key callers (session, cookie, proxy, authSkipped, legacy token) are
 * untouched: `scopeGuard` returns `next()` for them, so this narrows keys only
 * and can never deny something that was previously permitted to a session.
 */
export const apiWriteScopeGuard = createMiddleware<HonoEnv>(async (c, next) => {
  if (!c.req.path.startsWith('/api/v1/') || SAFE_METHODS.has(c.req.method)) return next()
  return requireWriteScope(c, next)
})
