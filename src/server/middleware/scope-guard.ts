import { createMiddleware } from 'hono/factory'
import { type ApiKeyScope, scopeSatisfies } from '@/core/auth/api-keys'
import { problem } from '@/server/helpers/problem'
import type { HonoEnv } from '@/server/types'

/**
 * Narrow what an API key may do. Session, cookie and proxy auth carry the
 * user's full rights and are deliberately unscoped -- a scope never grants
 * access, it only withholds it from a key.
 */
export function scopeGuard(required: ApiKeyScope) {
  return createMiddleware<HonoEnv>(async (c, next) => {
    if (c.get('authMethod') !== 'api-key') return next()
    if (scopeSatisfies(c.get('apiKeyScopes') ?? [], required)) return next()
    return problem(
      c,
      'insufficient-scope',
      'Insufficient scope',
      403,
      `This API key does not carry the '${required}' scope.`,
    )
  })
}
