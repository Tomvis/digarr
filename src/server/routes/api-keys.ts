import { Hono } from 'hono'
import { generateApiKey, parseScopes } from '@/core/auth/api-keys'
import type { ApiKeyStore } from '@/db/queries/api-keys'
import { problem } from '@/server/helpers/problem'
import { requireAdmin, requireSessionUser } from '@/server/helpers/require-user'
import { apiKeyIdParamSchema, createApiKeySchema } from '@/server/schemas/api-keys'
import { zJson, zParam } from '@/server/schemas/validator'
import type { HonoEnv } from '@/server/types'

export type ApiKeyRouteDeps = {
  apiKeyStore: ApiKeyStore
  getUserById: (id: number) => Promise<{ isAdmin: boolean } | null>
}

export function apiKeyRoutes(deps: ApiKeyRouteDeps) {
  const router = new Hono<HonoEnv>()

  // Session auth only, on every route below. An API key must never be able to
  // mint, list or revoke an API key -- that would make any leaked key
  // self-perpetuating and let a `write` key escalate itself to `admin`. This
  // includes the admin-wide listing below: it requires BOTH
  // `requireSessionUser` and `requireAdmin` to pass. The two are independent
  // boolean gates (order between them doesn't matter -- swapping the calls
  // produces identical behaviour), and it is specifically the presence of
  // `requireSessionUser` that matters: without it, an admin's own
  // `admin`-scoped API key would satisfy `requireAdmin` on its own and could
  // list every user's keys.

  router.get('/api/v1/api-keys', async (c) => {
    const auth = requireSessionUser(c)
    if (!auth.ok) return auth.response
    return c.json({ items: await deps.apiKeyStore.listForUser(auth.userId) })
  })

  // Admin visibility across every user's keys -- e.g. to spot a stale or
  // forgotten one. Deliberately read-only: an admin can see that a key
  // exists (id, owner, name, scopes, timestamps) but this never returns a
  // hash/secret, and there is no admin path to act on someone else's key --
  // only its owner can revoke it, via DELETE below.
  //
  // `all` is a static path segment, matched by Hono ahead of any parameterised
  // route, so it does not collide with `DELETE /api/v1/api-keys/:id` today --
  // that route also rejects a literal "all" as a 400 via the positive-int
  // param schema before it ever reaches userId ownership logic. Trip wire: a
  // future `GET /api/v1/api-keys/:id` would need to special-case (or be
  // ordered around) this path, or "all" would shadow it.
  router.get('/api/v1/api-keys/all', async (c) => {
    const sessionAuth = requireSessionUser(c)
    if (!sessionAuth.ok) return sessionAuth.response
    const adminAuth = await requireAdmin(c, deps.getUserById)
    if (!adminAuth.ok) return adminAuth.response
    return c.json({ items: await deps.apiKeyStore.listAll() })
  })

  router.post('/api/v1/api-keys', zJson(createApiKeySchema), async (c) => {
    const auth = requireSessionUser(c)
    if (!auth.ok) return auth.response
    const { name, scopes, expiresAt } = c.req.valid('json')

    const { token, prefix, keyHash } = generateApiKey()
    const key = await deps.apiKeyStore.create({
      userId: auth.userId,
      name,
      prefix,
      keyHash,
      scopes: parseScopes(scopes),
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    })

    // The only time the plaintext is ever returned. It is not recoverable
    // afterwards -- only its SHA-256 digest is stored.
    return c.json({ key, token }, 201)
  })

  router.delete('/api/v1/api-keys/:id', zParam(apiKeyIdParamSchema), async (c) => {
    const auth = requireSessionUser(c)
    if (!auth.ok) return auth.response
    const { id } = c.req.valid('param')
    const revoked = await deps.apiKeyStore.revoke({ id, userId: auth.userId })
    if (!revoked) {
      // 404 rather than 403: a key belonging to someone else must not be
      // distinguishable from one that does not exist.
      return problem(c, 'not-found', 'API key not found', 404)
    }
    return c.body(null, 204)
  })

  return router
}
