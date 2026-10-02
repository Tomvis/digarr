import type { Database } from '@/db'
import { getUserById, type UserPublic } from '@/db/queries/users'
import type { Preferences } from '@/db/schema'

/**
 * Resolve per-user preferences with fallback to global.
 * Returns the user's preferences layered over the global ones if the user
 * has any, otherwise the global preferences unchanged.
 *
 * Accepts either a Database instance (calls getUserById internally)
 * or a pre-bound lookup function (for routes using AppDependencies).
 */
export async function resolveUserPreferences(
  dbOrLookup: Database | ((id: number) => Promise<UserPublic | null>),
  globalPrefs: Partial<Preferences> | null,
  userId?: number,
): Promise<Partial<Preferences> | null> {
  if (!userId) return globalPrefs
  const user =
    typeof dbOrLookup === 'function'
      ? await dbOrLookup(userId)
      : await getUserById(dbOrLookup, userId)
  // Layer the user's keys over the global ones. Returning the user object
  // alone silently dropped every global key the user never set (e.g.
  // netNewAlbumDiscovery) the moment they set any preference at all.
  if (user?.preferences && Object.keys(user.preferences).length > 0) {
    return { ...(globalPrefs ?? {}), ...user.preferences }
  }
  return globalPrefs
}
