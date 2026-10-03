// @vitest-environment node
// HW-64 (fork): home theme state lives in users.preferences.homeTheme.
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from '@/db'
import {
  loadHomeThemeState,
  recordHomeThemeClaim,
  saveHomeThemeState,
} from '@/db/queries/home-theme'
import { users } from '@/db/schema'
import { makeTestDb } from '../helpers/test-db'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

describe('home theme queries', () => {
  let db: Database
  let close: () => Promise<void>
  let userId: number

  beforeEach(async () => {
    const testDb = await makeTestDb()
    db = testDb.db as unknown as Database
    close = testDb.close
    const [user] = await db
      .insert(users)
      .values({ username: 'tom', passwordHash: 'x', preferences: { scoreThreshold: 0.7 } as never })
      .returning({ id: users.id })
    userId = user?.id ?? 0
  })
  afterEach(async () => {
    await close()
  })

  it('starts empty', async () => {
    expect(await loadHomeThemeState(db, userId)).toEqual({ claim: null, choice: null })
  })

  it('saves without touching the scoring preferences', async () => {
    const state = {
      claim: { theme: 'dusk', mode: 'dark' as const, override: 'follow' },
      choice: { color: 'nord', mode: 'light' as const, basis: 'follow' },
    }
    await saveHomeThemeState(db, userId, state)
    expect(await loadHomeThemeState(db, userId)).toEqual(state)
    const [row] = await db.select().from(users).where(eq(users.id, userId))
    expect(row?.preferences).toMatchObject({ scoreThreshold: 0.7 })
  })

  it('a login claim with a new per-app override clears the in-app choice', async () => {
    await saveHomeThemeState(db, userId, {
      claim: null,
      choice: { color: 'nord', mode: 'light', basis: 'follow' },
    })
    let state = await recordHomeThemeClaim(db, userId, {
      theme: 'lime',
      mode: 'dark',
      override: 'follow',
    })
    expect(state.choice?.color).toBe('nord')
    state = await recordHomeThemeClaim(db, userId, {
      theme: 'ink',
      mode: 'light',
      override: 'ink/light',
    })
    expect(state).toEqual({
      claim: { theme: 'ink', mode: 'light', override: 'ink/light' },
      choice: null,
    })
    expect(await loadHomeThemeState(db, userId)).toEqual(state)
  })
})
