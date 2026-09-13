// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateApiKey, hashApiKeySecret, parseApiKey } from '@/core/auth/api-keys'
import type { Database } from '@/db'
import { apiKeyQueries } from '@/db/queries/api-keys'
import { apiKeys, users } from '@/db/schema'
import { makeTestDb } from '../helpers/test-db'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

describe('apiKeyQueries', () => {
  let db: Database
  let close: () => Promise<void>
  let store: ReturnType<typeof apiKeyQueries>
  let userId: number

  async function createUser(username: string): Promise<number> {
    const [user] = await db
      .insert(users)
      .values({ username, passwordHash: 'test-password-hash' })
      .returning({ id: users.id })
    if (!user) throw new Error('test user was not created')
    return user.id
  }

  beforeEach(async () => {
    const testDb = await makeTestDb()
    db = testDb.db as unknown as Database
    close = testDb.close
    store = apiKeyQueries(db)
    userId = await createUser('tom')
  })

  afterEach(async () => {
    await close()
  })

  async function mint(scopes: Array<'read' | 'write' | 'admin'> = ['read']) {
    const { token, prefix, keyHash } = generateApiKey()
    const row = await store.create({ userId, name: 'MA', prefix, keyHash, scopes, expiresAt: null })
    return { token, row, parsed: parseApiKey(token) }
  }

  it('verifies a freshly minted key', async () => {
    const { parsed } = await mint(['write'])
    const result = await store.verify(parsed?.prefix ?? '', parsed?.secret ?? '')
    expect(result?.userId).toBe(userId)
    expect(result?.scopes).toEqual(['write'])
  })

  it('rejects a correct prefix with the wrong secret', async () => {
    const { parsed } = await mint()
    const result = await store.verify(parsed?.prefix ?? '', 'not-the-secret')
    expect(result).toBeNull()
  })

  it('rejects an unknown prefix', async () => {
    await mint()
    expect(await store.verify('deadbeef', 'anything')).toBeNull()
  })

  it('rejects a revoked key', async () => {
    const { row, parsed } = await mint()
    expect(await store.revoke({ id: row.id, userId })).toBe(true)
    expect(await store.verify(parsed?.prefix ?? '', parsed?.secret ?? '')).toBeNull()
  })

  it('rejects an expired key', async () => {
    const { token, prefix, keyHash } = generateApiKey()
    await store.create({
      userId,
      name: 'stale',
      prefix,
      keyHash,
      scopes: ['read'],
      expiresAt: new Date(Date.now() - 1000),
    })
    const parsed = parseApiKey(token)
    expect(await store.verify(parsed?.prefix ?? '', parsed?.secret ?? '')).toBeNull()
  })

  it('never exposes the hash through the listing surface', async () => {
    await mint()
    const [listed] = await store.listForUser(userId)
    expect(listed).toBeDefined()
    expect(Object.keys(listed ?? {})).not.toContain('keyHash')
  })

  it("will not let one user revoke another user's key", async () => {
    const otherId = await createUser('lera')
    const { row, parsed } = await mint()
    expect(await store.revoke({ id: row.id, userId: otherId })).toBe(false)
    // Still usable: the failed revoke must not have taken effect.
    expect(await store.verify(parsed?.prefix ?? '', parsed?.secret ?? '')).not.toBeNull()
  })

  it('records last-used on touch', async () => {
    const { row } = await mint()
    await store.touchLastUsed(row.id)
    const [listed] = await store.listForUser(userId)
    expect(listed?.lastUsedAt).not.toBeNull()
  })

  it('stores only the hash of the secret', async () => {
    const { token } = await mint()
    const secret = parseApiKey(token)?.secret ?? ''
    const rows = await db.select().from(apiKeys)
    expect(rows[0]?.keyHash).toBe(hashApiKeySecret(secret))
    expect(rows[0]?.keyHash).not.toBe(secret)
  })
})
