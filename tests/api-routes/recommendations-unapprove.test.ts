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

function patchPending(
  app: ReturnType<typeof createTestApp>['app'],
  id: number,
  body: Record<string, unknown> = {},
) {
  return app.request(`/api/v1/recommendations/${id}`, {
    method: 'PATCH',
    headers: AUTH,
    body: JSON.stringify({ status: 'pending', ...body }),
  })
}

describe('PATCH /api/v1/recommendations/:id with status=pending', () => {
  describe('with removeLidarrArtist: true (unapprove)', () => {
    it('reverts the row and removes the Lidarr artist digarr added', async () => {
      const removeArtist = vi.fn(async () => {})
      const hasFiles = vi.fn(async () => false)
      const updateStatus = vi.fn(async () => {})
      const { app } = createTestApp({
        getRecommendation: vi.fn(async () =>
          makeRecommendation({ id: 1, userId: 1, status: 'approved', lidarrArtistId: 42 }),
        ) as never,
        updateRecommendationStatus: updateStatus,
        lidarrRemoveArtist: removeArtist,
        lidarrArtistHasFiles: hasFiles,
      } as never)
      const res = await patchPending(app, 1, { removeLidarrArtist: true })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ status: 'pending', lidarrArtistRemoved: true })
      // Both Lidarr calls carry the recommendation's OWN user: an artist id is
      // only meaningful inside the instance that issued it.
      expect(hasFiles).toHaveBeenCalledWith({ userId: 1, artistId: 42 })
      expect(removeArtist).toHaveBeenCalledWith({ userId: 1, artistId: 42, deleteFiles: false })
      expect(updateStatus).toHaveBeenCalledWith(
        1,
        'pending',
        expect.objectContaining({ lidarrArtistId: null }),
      )
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
      const res = await patchPending(app, 1, { removeLidarrArtist: true })
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
      const res = await patchPending(app, 1, { removeLidarrArtist: true })
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
      const res = await patchPending(app, 1, { removeLidarrArtist: true })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({
        status: 'pending',
        lidarrArtistRemoved: false,
        lidarrRemovalSkippedReason: 'removal_failed',
      })
    })

    it('still reverts the row when checking for files itself fails (cannot determine safely)', async () => {
      // Distinct from the "removal fails" test above: here the hasFiles check
      // itself throws, so removeArtist must never be reached (removing blind
      // would be the exact thing this guard exists to prevent), yet the skip
      // reason reported is the same 'removal_failed' as an actual removal
      // failure - both are "could not clear it in Lidarr" from the caller's
      // point of view.
      const removeArtist = vi.fn(async () => {})
      const { app } = createTestApp({
        getRecommendation: vi.fn(async () =>
          makeRecommendation({ id: 1, userId: 1, status: 'approved', lidarrArtistId: 42 }),
        ) as never,
        lidarrArtistHasFiles: vi.fn(async () => {
          throw new Error('lidarr unreachable')
        }),
        lidarrRemoveArtist: removeArtist,
      } as never)
      const res = await patchPending(app, 1, { removeLidarrArtist: true })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({
        status: 'pending',
        lidarrArtistRemoved: false,
        lidarrRemovalSkippedReason: 'removal_failed',
      })
      expect(removeArtist).not.toHaveBeenCalled()
    })

    it('falls back to the caller when the recommendation has no owner (legacy row)', async () => {
      const hasFiles = vi.fn(async () => false)
      const removeArtist = vi.fn(async () => {})
      const { app } = createTestApp({
        getRecommendation: vi.fn(async () =>
          makeRecommendation({ id: 1, userId: null, status: 'approved', lidarrArtistId: 42 }),
        ) as never,
        lidarrArtistHasFiles: hasFiles,
        lidarrRemoveArtist: removeArtist,
      } as never)
      await patchPending(app, 1, { removeLidarrArtist: true })
      expect(hasFiles).toHaveBeenCalledWith({ userId: 1, artistId: 42 })
      expect(removeArtist).toHaveBeenCalledWith({ userId: 1, artistId: 42, deleteFiles: false })
    })
  })

  describe('without the flag (plain revert / restore-to-pending)', () => {
    // The regression this guards: the Rejected tab's "restore to pending"
    // button PATCHes status='pending'. When removal was implied by the status
    // alone, restoring a rejected rec silently deleted its Lidarr artist.
    it.each([
      ['omitted', {}],
      ['explicitly false', { removeLidarrArtist: false }],
    ])('reverts the row and never touches Lidarr when the flag is %s', async (_case, body) => {
      const removeArtist = vi.fn(async () => {})
      const hasFiles = vi.fn(async () => false)
      const updateStatus = vi.fn(async () => {})
      const { app } = createTestApp({
        getRecommendation: vi.fn(async () =>
          makeRecommendation({ id: 1, userId: 1, status: 'rejected', lidarrArtistId: 42 }),
        ) as never,
        updateRecommendationStatus: updateStatus,
        lidarrRemoveArtist: removeArtist,
        lidarrArtistHasFiles: hasFiles,
      } as never)

      const res = await patchPending(app, 1, body)
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toMatchObject({ status: 'pending', lidarrArtistRemoved: false })
      // Nothing was attempted, so there is no skip reason to report.
      expect(json).not.toHaveProperty('lidarrRemovalSkippedReason')
      expect(hasFiles).not.toHaveBeenCalled()
      expect(removeArtist).not.toHaveBeenCalled()
      // The row keeps its lidarrArtistId: the artist is still in Lidarr.
      expect(updateStatus).toHaveBeenCalledWith(
        1,
        'pending',
        expect.not.objectContaining({ lidarrArtistId: null }),
      )
    })
  })
})
