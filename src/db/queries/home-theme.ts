// Per-user home theme state (HW-64, Tomvis fork only). Lives under the `homeTheme` key of
// users.preferences, so the fork needs no migration. Written with a jsonb merge so it never
// clobbers the scoring preferences stored next to it.
import { eq, sql } from 'drizzle-orm'
import {
  type HomeThemeState,
  parseHomeThemeClaim,
  parseHomeThemeState,
  reconcileHomeTheme,
} from '@/core/home-theme'
import type { Database } from '@/db'
import { users } from '@/db/schema'

export async function loadHomeThemeState(db: Database, userId: number): Promise<HomeThemeState> {
  const rows = await db
    .select({ raw: sql<unknown>`${users.preferences} -> 'homeTheme'` })
    .from(users)
    .where(eq(users.id, userId))
  return reconcileHomeTheme(parseHomeThemeState(rows[0]?.raw))
}

export async function saveHomeThemeState(
  db: Database,
  userId: number,
  state: HomeThemeState,
): Promise<void> {
  await db
    .update(users)
    .set({
      preferences: sql`coalesce(${users.preferences}, '{}'::jsonb) || jsonb_build_object('homeTheme', ${JSON.stringify(state)}::jsonb)`,
    })
    .where(eq(users.id, userId))
}

/** Store the claim from an OIDC login; clears an in-app choice the claim invalidates. */
export async function recordHomeThemeClaim(
  db: Database,
  userId: number,
  rawClaim: unknown,
): Promise<HomeThemeState> {
  const current = await loadHomeThemeState(db, userId)
  const next = reconcileHomeTheme({ claim: parseHomeThemeClaim(rawClaim), choice: current.choice })
  await saveHomeThemeState(db, userId, next)
  return next
}
