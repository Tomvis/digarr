// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { makeRecommendation } from '../helpers/factories'
import { createTestApp } from '../helpers/test-app'

vi.mock('@/core/sessions', () => ({
  getSession: vi.fn().mockResolvedValue({
    userId: 1,
    token: 'tok',
    expiresAt: new Date(Date.now() + 86400000),
  }),
}))

const AUTH = { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }

function patchPending(app: ReturnType<typeof createTestApp>['app'], id: number) {
  return app.request(`/api/v1/recommendations/${id}`, {
    method: 'PATCH',
    headers: AUTH,
    body: JSON.stringify({ status: 'pending' }),
  })
}

describe('PATCH /api/v1/recommendations/:id with status=pending', () => {
  it('reverts the row and removes the Lidarr artist digarr added', async () => {
    const removeArtist = vi.fn(async () => {})
    const { app } = createTestApp({
      getRecommendation: vi.fn(async () =>
        makeRecommendation({ id: 1, userId: 1, status: 'approved', lidarrArtistId: 42 }),
      ) as never,
      lidarrRemoveArtist: removeArtist,
      lidarrArtistHasFiles: vi.fn(async () => false),
    } as never)
    const res = await patchPending(app, 1)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'pending', lidarrArtistRemoved: true })
    expect(removeArtist).toHaveBeenCalledWith(42, { deleteFiles: false })
  })

  it('reverts but keeps the artist when files already downloaded', async () => {
    const removeArtist = vi.fn(async () => {})
    const { app } = createTestApp({
      getRecommendation: vi.fn(async () =>
        makeRecommendation({ id: 1, userId: 1, status: 'approved', lidarrArtistId: 42 }),
      ) as never,
      lidarrRemoveArtist: removeArtist,
      lidarrArtistHasFiles: vi.fn(async () => true),
    } as never)
    const res = await patchPending(app, 1)
    expect(await res.json()).toMatchObject({
      status: 'pending',
      lidarrArtistRemoved: false,
      lidarrRemovalSkippedReason: 'has_files',
    })
    expect(removeArtist).not.toHaveBeenCalled()
  })

  it('reverts but keeps nothing to remove when digarr never added the artist', async () => {
    const removeArtist = vi.fn(async () => {})
    const { app } = createTestApp({
      getRecommendation: vi.fn(async () =>
        makeRecommendation({ id: 1, userId: 1, status: 'approved', lidarrArtistId: null }),
      ) as never,
      lidarrRemoveArtist: removeArtist,
    } as never)
    const res = await patchPending(app, 1)
    expect(await res.json()).toMatchObject({
      status: 'pending',
      lidarrArtistRemoved: false,
      lidarrRemovalSkippedReason: 'not_added_by_digarr',
    })
    expect(removeArtist).not.toHaveBeenCalled()
  })

  it('still reverts the row when the Lidarr removal fails', async () => {
    const { app } = createTestApp({
      getRecommendation: vi.fn(async () =>
        makeRecommendation({ id: 1, userId: 1, status: 'approved', lidarrArtistId: 42 }),
      ) as never,
      lidarrRemoveArtist: vi.fn(async () => {
        throw new Error('lidarr down')
      }),
      lidarrArtistHasFiles: vi.fn(async () => false),
    } as never)
    const res = await patchPending(app, 1)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      status: 'pending',
      lidarrArtistRemoved: false,
      lidarrRemovalSkippedReason: 'removal_failed',
    })
  })
})
