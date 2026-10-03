// Per-user home theme (HW-64, Tomvis fork only). See src/core/home-theme.ts for precedence.
import { Hono } from 'hono'
import * as z from 'zod'
import {
  currentBasis,
  effectiveHomeTheme,
  type HomeThemeState,
  isValidChoiceColor,
} from '@/core/home-theme'
import { requireSessionUser, requireUser } from '@/server/helpers/require-user'
import { zJson } from '@/server/schemas/validator'
import type { HonoEnv } from '@/server/types'

export type HomeThemeRouteDeps = {
  loadHomeThemeState: (userId: number) => Promise<HomeThemeState>
  saveHomeThemeState: (userId: number, state: HomeThemeState) => Promise<void>
}

const updateHomeThemeSchema = z.union([
  z.object({ follow: z.literal(true) }).strict(),
  z
    .object({
      color: z.string().refine(isValidChoiceColor, 'invalid theme id'),
      mode: z.enum(['dark', 'light', 'system']),
    })
    .strict(),
])

function body(state: HomeThemeState) {
  return { claim: state.claim, choice: state.choice, effective: effectiveHomeTheme(state) }
}

export function homeThemeRoutes(deps: HomeThemeRouteDeps) {
  const router = new Hono<HonoEnv>()

  router.get('/api/v1/auth/me/theme', async (c) => {
    const auth = requireUser(c)
    if (!auth.ok) return auth.response
    c.header('Cache-Control', 'no-store')
    return c.json(body(await deps.loadHomeThemeState(auth.userId)))
  })

  router.put('/api/v1/auth/me/theme', zJson(updateHomeThemeSchema), async (c) => {
    const auth = requireSessionUser(c)
    if (!auth.ok) return auth.response
    const input = c.req.valid('json')
    const current = await deps.loadHomeThemeState(auth.userId)
    const next: HomeThemeState = {
      claim: current.claim,
      choice:
        'follow' in input
          ? null
          : { color: input.color, mode: input.mode, basis: currentBasis(current.claim) },
    }
    await deps.saveHomeThemeState(auth.userId, next)
    c.header('Cache-Control', 'no-store')
    return c.json(body(next))
  })

  return router
}
