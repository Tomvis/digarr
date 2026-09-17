// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from '@/db'
import { listUserIdsWithMusicRaterConnection, updateUserPreferredLocale } from '@/db/queries/users'
import { users } from '@/db/schema'
import { makeTestDb } from '../../helpers/test-db'

describe('updateUserPreferredLocale', () => {
  it('updates the preferred locale for a user', async () => {
    const chain = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(undefined),
    }
    const db = { update: vi.fn().mockReturnValue(chain) } as unknown as Database

    await updateUserPreferredLocale(db, 1, 'de')

    expect(db.update).toHaveBeenCalledOnce()
    expect(chain.set).toHaveBeenCalledWith({ preferredLocale: 'de' })
    expect(chain.where).toHaveBeenCalledOnce()
  })
})

/**
 * Real-DB coverage for the empty-string disconnect gap: clearing the URL is
 * the settings card's only music-rater disconnect gesture, and it sends
 * `musicRaterUrl: ''` verbatim while leaving the (still non-null, still
 * encrypted) API key alone. A plain `IS NOT NULL` on both columns would keep
 * scheduling a nightly sync for a user who is, by every other measure
 * (`hasMusicRater`), disconnected.
 */
describe('listUserIdsWithMusicRaterConnection (real db)', () => {
  let db: Database
  let close: () => Promise<void>

  beforeEach(async () => {
    const testDb = await makeTestDb()
    db = testDb.db as unknown as Database
    close = testDb.close
  })

  afterEach(async () => {
    await close()
  })

  it('includes a user with both fields set to non-empty strings', async () => {
    const [user] = await db
      .insert(users)
      .values({
        username: 'connected',
        passwordHash: 'x',
        musicRaterUrl: 'http://mr.example',
        musicRaterApiKey: 'mr_secret',
      })
      .returning({ id: users.id })
    if (!user) throw new Error('test user was not created')

    expect(await listUserIdsWithMusicRaterConnection(db)).toEqual([user.id])
  })

  it('excludes a user who never connected (both null)', async () => {
    await db.insert(users).values({ username: 'never-connected', passwordHash: 'x' })

    expect(await listUserIdsWithMusicRaterConnection(db)).toEqual([])
  })

  it('excludes a user who disconnected by clearing the URL to an empty string', async () => {
    await db.insert(users).values({
      username: 'disconnected',
      passwordHash: 'x',
      musicRaterUrl: '',
      musicRaterApiKey: 'mr_secret',
    })

    expect(await listUserIdsWithMusicRaterConnection(db)).toEqual([])
  })

  it('excludes a user with an empty-string API key', async () => {
    await db.insert(users).values({
      username: 'empty-key',
      passwordHash: 'x',
      musicRaterUrl: 'http://mr.example',
      musicRaterApiKey: '',
    })

    expect(await listUserIdsWithMusicRaterConnection(db)).toEqual([])
  })
})
