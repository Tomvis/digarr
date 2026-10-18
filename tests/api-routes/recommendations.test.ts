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

describe('API routes: recommendations list', () => {
  it('returns paginated recommendations', async () => {
    const rec = makeRecommendation({ status: 'pending' })
    const { app } = createTestApp({
      listRecommendations: vi.fn(async () => ({ items: [rec], total: 1 })) as never,
    })

    const res = await app.request('/api/v1/recommendations', {
      headers: { Authorization: 'Bearer tok' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.total).toBe(1)
    expect(body.items).toHaveLength(1)
  })
})

describe('API routes: approve/reject', () => {
  it('rejects a recommendation', async () => {
    const rec = makeRecommendation({ id: 2, status: 'pending' })
    const { app, deps } = createTestApp({
      getRecommendation: vi.fn(async () => rec) as never,
      filterOwnedIds: vi.fn(async (ids: number[]) => ids),
    })

    const res = await app.request('/api/v1/recommendations/2', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer tok',
      },
      body: JSON.stringify({ status: 'rejected' }),
    })
    expect(res.status).toBe(200)
    // Rejection routes through rejectRecommendation now (transactional dual-write
    // path that also handles the optional permanent-block flag).
    expect(deps.rejectRecommendation).toHaveBeenCalledWith(
      expect.objectContaining({ recommendationId: 2, reason: null, permanent: false }),
    )
  })

  it('returns 400 for invalid status', async () => {
    const { app } = createTestApp()

    const res = await app.request('/api/v1/recommendations/1', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer tok',
      },
      body: JSON.stringify({ status: 'invalid_status' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 when recommendation does not exist', async () => {
    const { app } = createTestApp({
      getRecommendation: vi.fn(async () => null),
    })

    const res = await app.request('/api/v1/recommendations/999', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer tok',
      },
      body: JSON.stringify({ status: 'rejected' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('API routes: track recommendations', () => {
  it('ignores removeLidarrArtist when reverting a track rec', async () => {
    const removeArtist = vi.fn(async () => {})
    const hasFiles = vi.fn(async () => false)
    const updateStatus = vi.fn(async () => {})
    const rec = makeRecommendation({
      id: 3,
      userId: 1,
      kind: 'track',
      status: 'approved',
      recommendedTrackTitle: 'Song',
      // Defensive: even a stray artist id on a track rec must not be removed.
      lidarrArtistId: 42,
    })
    const { app } = createTestApp({
      getRecommendation: vi.fn(async () => rec) as never,
      updateRecommendationStatus: updateStatus,
      lidarrRemoveArtist: removeArtist,
      lidarrArtistHasFiles: hasFiles,
    } as never)

    const res = await app.request('/api/v1/recommendations/3', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
      body: JSON.stringify({ status: 'pending', removeLidarrArtist: true }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'pending', lidarrArtistRemoved: false })
    expect(hasFiles).not.toHaveBeenCalled()
    expect(removeArtist).not.toHaveBeenCalled()
    expect(updateStatus).toHaveBeenCalledWith(
      3,
      'pending',
      expect.not.objectContaining({ lidarrArtistId: null }),
    )
  })

  it('approves a track rec through an explicit songpick targetId', async () => {
    const rec = makeRecommendation({
      id: 4,
      userId: 1,
      kind: 'track',
      recommendedTrackTitle: 'Song',
      recommendedRecordingMbid: 'rec-1',
    })
    const addTrack = vi.fn(async () => ({
      success: true,
      targetType: 'songpick',
      targetId: 1,
      songpickStatus: 'wanted',
    }))
    const { app } = createTestApp({
      getRecommendation: vi.fn(async () => rec) as never,
      getEnabledTargetsForUser: vi.fn(async () => [
        {
          id: 'songpick-1',
          name: 'songpick',
          type: 'songpick',
          capabilities: ['addTrack'],
          addTrack,
        },
      ]) as never,
    })

    const res = await app.request('/api/v1/recommendations/4', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
      body: JSON.stringify({ status: 'approved', targetId: 'songpick-1' }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      status: 'approved',
      targetActions: { 'songpick-1': { success: true, songpickStatus: 'wanted' } },
    })
    expect(addTrack).toHaveBeenCalledOnce()
  })
})
