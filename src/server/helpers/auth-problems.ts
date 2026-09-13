import type { Context } from 'hono'
import { problem } from '@/server/helpers/problem'
import type { HonoEnv } from '@/server/types'

export function notAuthenticated(c: Context<HonoEnv>) {
  c.header('WWW-Authenticate', 'Bearer realm="digarr"')
  return problem(
    c,
    'not-authenticated',
    'Not authenticated',
    401,
    undefined,
    undefined,
    'errors.auth.notAuthenticated',
  )
}

export function sessionAuthRequired(c: Context<HonoEnv>) {
  return problem(
    c,
    'session-auth-required',
    'Session authentication required',
    403,
    undefined,
    undefined,
    'errors.auth.notAuthenticated',
  )
}

export function insufficientScope(c: Context<HonoEnv>, required: string) {
  return problem(
    c,
    'insufficient-scope',
    'Insufficient scope',
    403,
    `This API key does not carry the '${required}' scope.`,
    undefined,
    'errors.auth.insufficientScope',
  )
}

export function adminRequired(c: Context<HonoEnv>) {
  return problem(
    c,
    'admin-required',
    'Admin access required',
    403,
    undefined,
    undefined,
    'common.adminAccessRequired',
  )
}
