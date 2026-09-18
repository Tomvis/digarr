import { Hono } from 'hono'
import {
  EMPTY_DISCOVERY_SNAPSHOT,
  evaluateDiscoveryModeAvailability,
} from '@/core/discovery-modes/availability'
import { createDefaultDiscoveryModeRegistry } from '@/core/discovery-modes/registry'
import type { DiscoveryConfigField } from '@/core/discovery-modes/types'
import type { AppDependencies } from '@/server'
import { notAuthenticated } from '@/server/helpers/auth-problems'
import type { HonoEnv } from '@/server/types'

export function discoveryModeRoutes(deps: AppDependencies) {
  const router = new Hono<HonoEnv>()
  const discoveryModeRegistry = deps.discoveryModeRegistry ?? createDefaultDiscoveryModeRegistry()
  const getDiscoveryConnectionSnapshot =
    deps.getDiscoveryConnectionSnapshot ?? (async () => EMPTY_DISCOVERY_SNAPSHOT)

  router.get('/api/v1/discovery-modes', async (c) => {
    const userId = c.get('userId')
    if (!userId) {
      return notAuthenticated(c)
    }

    const snapshot = await getDiscoveryConnectionSnapshot(userId)
    const modes = await Promise.all(
      discoveryModeRegistry.list().map(async (mode) => {
        // A resolver reaches the database, so it must not be able to fail the
        // whole modes page. Degrading to empty options renders the field as
        // the free-text input, which is exactly the pre-resolver behaviour.
        let resolved: Record<string, DiscoveryConfigField['options']> = {}
        if (mode.resolveOptions) {
          try {
            resolved = await mode.resolveOptions(userId)
          } catch (err) {
            console.error(`[discovery-modes] resolveOptions failed for ${mode.id}`, err)
          }
        }
        const withOptions = (fields: DiscoveryConfigField[]) =>
          fields.map((field) =>
            resolved[field.key] ? { ...field, options: resolved[field.key] } : field,
          )

        return {
          id: mode.id,
          label: mode.label,
          description: mode.description,
          availability: evaluateDiscoveryModeAvailability(mode.id, snapshot),
          stability: mode.stability ?? 'stable',
          easyFields: withOptions(mode.easyFields),
          advancedFields: withOptions(mode.advancedFields),
        }
      }),
    )

    return c.json({ modes })
  })

  return router
}
