import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from '@/db'
import { getRecommendedRecordingMbids } from '@/db/queries/recommendations'

const { mockedEq, mockedAnd, mockedIsNull } = vi.hoisted(() => ({
  mockedEq: vi.fn((left: unknown, right: unknown) => ({ op: 'eq', left, right })),
  mockedAnd: vi.fn((...clauses: unknown[]) => ({ op: 'and', clauses })),
  mockedIsNull: vi.fn((col: unknown) => ({ op: 'isNull', col })),
}))

vi.mock('drizzle-orm', async (importOriginal) => {
  const original = await importOriginal<typeof import('drizzle-orm')>()
  return { ...original, eq: mockedEq, and: mockedAnd, isNull: mockedIsNull }
})

beforeEach(() => {
  mockedEq.mockClear()
  mockedAnd.mockClear()
  mockedIsNull.mockClear()
})

function makeDb(rows: unknown[]): Database {
  const chain: Record<string, unknown> = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockResolvedValue(rows)
  return { select: vi.fn().mockReturnValue(chain) } as unknown as Database
}

describe('getRecommendedRecordingMbids', () => {
  it('returns non-null mbids, scoped to kind=track and the user', async () => {
    const db = makeDb([{ mbid: 'r-1' }, { mbid: null }, { mbid: 'r-2' }])
    const result = await getRecommendedRecordingMbids(db, 5)
    expect([...result]).toEqual(['r-1', 'r-2'])
    expect(mockedEq).toHaveBeenCalledWith(expect.anything(), 'track')
    expect(mockedEq).toHaveBeenCalledWith(expect.anything(), 5)
    expect(mockedIsNull).not.toHaveBeenCalled()
  })

  it('uses IS NULL for the null user and applies no status filter', async () => {
    const db = makeDb([])
    await getRecommendedRecordingMbids(db, null)
    expect(mockedIsNull).toHaveBeenCalledTimes(1)
    const statusCalls = mockedEq.mock.calls.filter(
      ([, r]) => typeof r === 'string' && r !== 'track',
    )
    expect(statusCalls).toEqual([])
  })
})
