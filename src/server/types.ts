import type {
  DiscoveryAvailabilityResult,
  DiscoveryConnectionSnapshot,
} from '@/core/discovery-modes/availability'

export type AuthMethod =
  | 'session-bearer'
  | 'session-cookie'
  | 'session-query'
  | 'legacy-bearer'
  | 'legacy-query'
  | 'api-key'
  | 'proxy'

export type HonoEnv = {
  Variables: {
    userId?: number
    authMethod?: AuthMethod
    proxyAuth?: boolean
    legacyTokenAuth?: boolean
    /** Id of the API key that authenticated this request, when authMethod is 'api-key'. */
    apiKeyId?: number
    /** Scopes granted to that key. Absent for every other auth method, which are unscoped. */
    apiKeyScopes?: string[]
    /** True when auth middleware determined no auth is configured (no users, no legacy token). */
    authSkipped?: boolean
  }
}

export type { DiscoveryAvailabilityResult, DiscoveryConnectionSnapshot }
