// @vitest-environment node

import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HonoEnv } from '@/server/types'

const mockDeps = {
  db: {} as never,
  getRecommendation: vi.fn(),
  updateRecommendationStatus: vi.fn().mockResolvedValue(undefined),
  rejectRecommendation: vi.fn().mockResolvedValue({ artistId: 1, blockCreated: false }),
  listArtistBlocks: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
  removeArtistBlock: vi.fn().mockResolvedValue(true),
  addArtistBlock: vi.fn().mockResolvedValue(undefined),
  bulkUpdateStatus: vi.fn().mockResolvedValue(undefined),
  bulkRejectRecommendations: vi.fn().mockResolvedValue({ rejected: 0, blocksCreated: 0 }),
  filterOwnedIds: vi.fn(async (ids: number[]) => ids),
  listRecommendations: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  getSettings: vi.fn().mockResolvedValue({ preferences: {} }),
  getUserById: vi.fn().mockResolvedValue(null),
  skyhookWarmer: null,
  getEnabledTargetsForUser: vi.fn().mockResolvedValue([]),
}

const { recommendationRoutes } = await import('@/server/routes/recommendations')

function createTestApp() {
  const app = new Hono<HonoEnv>()
  app.use('*', async (c, next) => {
    c.set('userId', 1)
    await next()
  })
  app.route('/', recommendationRoutes(mockDeps as never))
  return app
}

describe('target-aware approval', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each([null, 2])('treats a recommendation owned by %s as not found', async (owner) => {
    mockDeps.getRecommendation.mockResolvedValue({
      userId: owner,
      id: 1,
      artist: { mbid: 'mbid-1', name: 'Radiohead' },
    })

    const res = await createTestApp().request('/api/v1/recommendations/1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    })

    expect(res.status).toBe(404)
    expect(mockDeps.updateRecommendationStatus).not.toHaveBeenCalled()
  })

  it('approves without targets - sets status to approved', async () => {
    mockDeps.getRecommendation.mockResolvedValue({
      userId: 1,
      id: 1,
      artist: { mbid: 'mbid-1', name: 'Radiohead' },
    })
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([])

    const app = createTestApp()
    const res = await app.request('/api/v1/recommendations/1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('approved')
    expect(mockDeps.updateRecommendationStatus).toHaveBeenCalledWith(
      1,
      'approved',
      expect.objectContaining({ targetActions: {} }),
    )
  })

  it('first approval accepts an existing Lidarr artist and sets added_to_lidarr', async () => {
    mockDeps.getRecommendation.mockResolvedValue({
      userId: 1,
      id: 1,
      artist: { mbid: 'mbid-1', name: 'Radiohead' },
    })
    const mockTarget = {
      id: 'lidarr-1',
      type: 'lidarr',
      capabilities: ['addArtist'],
      addArtist: vi.fn().mockResolvedValue({
        success: true,
        targetType: 'lidarr',
        targetId: 1,
        externalId: 42,
      }),
    }
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([mockTarget])

    const app = createTestApp()
    const res = await app.request('/api/v1/recommendations/1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    })

    const body = await res.json()
    expect(body.status).toBe('added_to_lidarr')
    expect(mockTarget.addArtist).toHaveBeenCalledWith(
      { mbid: 'mbid-1', name: 'Radiohead' },
      expect.objectContaining({ retryExisting: true }),
    )
  })

  it('partial Lidarr add (artist added, album not monitored) persists the artist link and warns, not orphaned', async () => {
    mockDeps.getRecommendation.mockResolvedValue({
      userId: 1,
      id: 1,
      artist: { mbid: 'mbid-1', name: 'Radiohead' },
    })
    const mockTarget = {
      id: 'lidarr-1',
      name: 'Lidarr',
      type: 'lidarr',
      capabilities: ['addArtist'],
      addArtist: vi.fn().mockResolvedValue({
        success: true,
        targetType: 'lidarr',
        targetId: 1,
        externalId: 42,
        warning: 'artist added, but the selected album was not found in Lidarr',
      }),
    }
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([mockTarget])

    const app = createTestApp()
    const res = await app.request('/api/v1/recommendations/1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    })

    const body = await res.json()
    // The artist link must persist (no orphan -> retry reconciles, no duplicate).
    expect(body.status).toBe('added_to_lidarr')
    expect(mockDeps.updateRecommendationStatus).toHaveBeenCalledWith(
      1,
      'added_to_lidarr',
      expect.objectContaining({ lidarrArtistId: 42 }),
    )
    // The partial outcome is surfaced, not silent.
    expect(body.targetSummary.warnings).toContain(
      'artist added, but the selected album was not found in Lidarr',
    )
  })

  it('approves with failing Lidarr target - sets add_failed', async () => {
    mockDeps.getRecommendation.mockResolvedValue({
      userId: 1,
      id: 1,
      artist: { mbid: 'mbid-1', name: 'Radiohead' },
    })
    const mockTarget = {
      id: 'lidarr-1',
      type: 'lidarr',
      capabilities: ['addArtist'],
      addArtist: vi.fn().mockResolvedValue({
        success: false,
        targetType: 'lidarr',
        targetId: 1,
        error: 'Already exists',
      }),
    }
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([mockTarget])

    const app = createTestApp()
    const res = await app.request('/api/v1/recommendations/1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    })

    const body = await res.json()
    expect(body.status).toBe('add_failed')
  })

  it('approves with createPlaylist-only targets - sets approved', async () => {
    mockDeps.getRecommendation.mockResolvedValue({
      userId: 1,
      id: 1,
      artist: { mbid: 'mbid-1', name: 'Radiohead' },
    })
    const spotifyTarget = {
      id: 'spotify-playlist-1',
      type: 'spotify-playlist',
      capabilities: ['createPlaylist'],
      openPlaylistExportSession: vi.fn(),
      testConnection: vi.fn(),
    }
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([spotifyTarget])

    const app = createTestApp()
    const res = await app.request('/api/v1/recommendations/1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    })

    const body = await res.json()
    expect(body.status).toBe('approved')
    expect(mockDeps.updateRecommendationStatus).toHaveBeenCalledWith(
      1,
      'approved',
      expect.objectContaining({ targetActions: {} }),
    )
    expect(spotifyTarget.openPlaylistExportSession).not.toHaveBeenCalled()
  })

  it('approves to specific target via targetId', async () => {
    mockDeps.getRecommendation.mockResolvedValue({
      userId: 1,
      id: 1,
      artist: { mbid: 'mbid-1', name: 'Radiohead' },
    })
    const lidarrTarget1 = {
      id: 'lidarr-1',
      type: 'lidarr',
      capabilities: ['addArtist'],
      addArtist: vi.fn().mockResolvedValue({
        success: true,
        targetType: 'lidarr',
        targetId: 1,
        externalId: 42,
      }),
      testConnection: vi.fn(),
    }
    const lidarrTarget2 = {
      id: 'lidarr-2',
      type: 'lidarr',
      capabilities: ['addArtist'],
      addArtist: vi.fn().mockResolvedValue({
        success: true,
        targetType: 'lidarr',
        targetId: 2,
        externalId: 99,
      }),
      testConnection: vi.fn(),
    }
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([lidarrTarget1, lidarrTarget2])

    const app = createTestApp()
    const res = await app.request('/api/v1/recommendations/1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved', targetId: 'lidarr-2' }),
    })

    const body = await res.json()
    expect(body.status).toBe('added_to_lidarr')
    // Only lidarr-2 should be called
    expect(lidarrTarget2.addArtist).toHaveBeenCalled()
    expect(lidarrTarget1.addArtist).not.toHaveBeenCalled()
  })

  it('handles multiple addArtist targets', async () => {
    mockDeps.getRecommendation.mockResolvedValue({
      userId: 1,
      id: 1,
      artist: { mbid: 'mbid-1', name: 'Radiohead' },
    })
    const lidarrTarget1 = {
      id: 'lidarr-1',
      type: 'lidarr',
      capabilities: ['addArtist'],
      addArtist: vi.fn().mockResolvedValue({
        success: true,
        targetType: 'lidarr',
        targetId: 1,
        externalId: 42,
      }),
      testConnection: vi.fn(),
    }
    const lidarrTarget2 = {
      id: 'lidarr-2',
      type: 'lidarr',
      capabilities: ['addArtist'],
      addArtist: vi.fn().mockResolvedValue({
        success: true,
        targetType: 'lidarr',
        targetId: 2,
        externalId: 99,
      }),
      testConnection: vi.fn(),
    }
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([lidarrTarget1, lidarrTarget2])

    const app = createTestApp()
    const res = await app.request('/api/v1/recommendations/1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    })

    const body = await res.json()
    expect(body.status).toBe('added_to_lidarr')
    expect(lidarrTarget1.addArtist).toHaveBeenCalled()
    expect(lidarrTarget2.addArtist).toHaveBeenCalled()
    expect(body.targetActions['lidarr-1'].status).toBe('added')
    expect(body.targetActions['lidarr-2'].status).toBe('added')
  })

  it('bulk approve with addArtist targets', async () => {
    mockDeps.getRecommendation.mockResolvedValue({
      userId: 1,
      id: 1,
      artist: { mbid: 'mbid-1', name: 'Radiohead' },
    })
    const mockTarget = {
      id: 'lidarr-1',
      type: 'lidarr',
      capabilities: ['addArtist'],
      addArtist: vi.fn().mockResolvedValue({
        success: true,
        targetType: 'lidarr',
        targetId: 1,
        externalId: 42,
      }),
      testConnection: vi.fn(),
    }
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([mockTarget])

    const app = createTestApp()
    const res = await app.request('/api/v1/recommendations/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [1], action: 'approve' }),
    })

    const body = await res.json()
    expect(body.results[0].status).toBe('added_to_lidarr')
    expect(mockTarget.addArtist).toHaveBeenCalledWith(
      { mbid: 'mbid-1', name: 'Radiohead' },
      expect.any(Object),
    )
  })

  it('bulk approve without targets marks all as approved', async () => {
    mockDeps.getRecommendation.mockResolvedValue({
      userId: 1,
      id: 1,
      artist: { mbid: 'mbid-1', name: 'Radiohead' },
    })
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([])

    const app = createTestApp()
    const res = await app.request('/api/v1/recommendations/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [1], action: 'approve' }),
    })

    const body = await res.json()
    expect(body.results[0].status).toBe('approved')
  })

  it.each([
    { scenario: 'Lidarr success', lidarr: true, slskd: false, status: 'added_to_lidarr' },
    { scenario: 'Lidarr failure', lidarr: false, slskd: false, status: 'add_failed' },
    { scenario: 'slskd queued', lidarr: null, slskd: true, status: 'approved' },
    { scenario: 'Lidarr failed and slskd queued', lidarr: false, slskd: true, status: 'approved' },
  ])(
    'bulk album approval preserves target outcome: $scenario',
    async ({ lidarr, slskd, status }) => {
      mockDeps.getRecommendation.mockResolvedValue({
        userId: 1,
        id: 1,
        kind: 'album',
        recommendedReleaseGroupId: 'rg-1',
        artist: { mbid: 'mbid-1', name: 'Radiohead' },
      })
      const targets = [
        ...(lidarr !== null ? [{ type: 'lidarr', success: lidarr }] : []),
        ...(slskd ? [{ type: 'slskd', success: true }] : []),
      ].map(({ type, success }) => ({
        id: `${type}-1`,
        type,
        capabilities: ['addArtist', 'addAlbum'],
        addArtist: vi.fn(),
        addAlbum: vi
          .fn()
          .mockResolvedValue(
            success
              ? { success, externalId: 7 }
              : { success, error: 'HTTP 404: album not found in Lidarr' },
          ),
      }))
      mockDeps.getEnabledTargetsForUser.mockResolvedValue(targets)

      const res = await createTestApp().request('/api/v1/recommendations/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids: [1],
          action: 'approve',
          qualityProfileId: 2,
          metadataProfileId: 3,
          rootFolderId: 4,
        }),
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        results: [
          lidarr === false && !slskd
            ? { id: 1, status, error: 'HTTP 404: album not found in Lidarr' }
            : { id: 1, status },
        ],
      })
      for (const target of targets) {
        expect(target.addAlbum).toHaveBeenCalledExactlyOnceWith(
          { artistMbid: 'mbid-1', artistName: 'Radiohead', releaseGroupMbid: 'rg-1' },
          {
            // Explicit picks are scoped to the only Lidarr target, dropped without one.
            ...(lidarr !== null
              ? {
                  lidarrOptionsTargetId: 'lidarr-1',
                  qualityProfileId: 2,
                  metadataProfileId: 3,
                  rootFolderId: 4,
                }
              : {}),
            userId: 1,
            recommendationId: 1,
          },
        )
        expect(target.addArtist).not.toHaveBeenCalled()
      }
      expect(mockDeps.updateRecommendationStatus).toHaveBeenCalledExactlyOnceWith(1, status, {
        targetActions: {
          ...(lidarr !== null
            ? {
                'lidarr-1': {
                  status: lidarr ? 'added' : 'failed',
                  externalId: lidarr ? 7 : undefined,
                  error: lidarr ? undefined : 'HTTP 404: album not found in Lidarr',
                },
              }
            : {}),
          ...(slskd ? { 'slskd-1': { status: 'queued', externalId: 7, error: undefined } } : {}),
        },
        ...(lidarr === false ? { lidarrError: 'HTTP 404: album not found in Lidarr' } : {}),
      })
    },
  )

  it.each(['artist-only target', 'missing release group', 'no targets'])(
    'bulk album approval fails without artist acquisition: %s',
    async (scenario) => {
      mockDeps.getRecommendation.mockResolvedValue({
        userId: 1,
        id: 1,
        kind: 'album',
        recommendedReleaseGroupId: scenario === 'missing release group' ? null : 'rg-1',
        artist: { mbid: 'mbid-1', name: 'Radiohead' },
      })
      const target = {
        id: 'lidarr-1',
        type: 'lidarr',
        capabilities: scenario === 'artist-only target' ? ['addArtist'] : ['addArtist', 'addAlbum'],
        addArtist: vi.fn(),
        addAlbum: vi.fn(),
      }
      mockDeps.getEnabledTargetsForUser.mockResolvedValue(scenario === 'no targets' ? [] : [target])

      const res = await createTestApp().request('/api/v1/recommendations/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids: [1],
          action: 'approve',
          ...(scenario === 'no targets' ? {} : { targetId: target.id }),
        }),
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ results: [{ id: 1, status: 'add_failed' }] })
      expect(target.addArtist).not.toHaveBeenCalled()
      expect(target.addAlbum).not.toHaveBeenCalled()
      expect(mockDeps.updateRecommendationStatus).toHaveBeenCalledExactlyOnceWith(1, 'add_failed', {
        targetActions: {},
      })
    },
  )

  it('bulk approval dispatches mixed rows by kind and skips unowned or missing rows', async () => {
    mockDeps.getRecommendation.mockImplementation(async (id: number) => {
      if (id === 4) return null
      return {
        id,
        userId: id === 3 ? 2 : 1,
        kind: id === 1 ? 'album' : 'artist',
        recommendedReleaseGroupId: id === 1 ? 'rg-1' : null,
        artist: { mbid: `mbid-${id}`, name: `Artist ${id}` },
      }
    })
    const target = {
      id: 'lidarr-1',
      type: 'lidarr',
      capabilities: ['addArtist', 'addAlbum'],
      addArtist: vi.fn().mockResolvedValue({ success: true, externalId: 42 }),
      addAlbum: vi.fn().mockResolvedValue({ success: true, externalId: 7 }),
    }
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([target])

    const res = await createTestApp().request('/api/v1/recommendations/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [1, 2, 3, 4], action: 'approve' }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      results: [
        { id: 1, status: 'added_to_lidarr' },
        { id: 2, status: 'added_to_lidarr' },
        { id: 3, status: 'not_found' },
        { id: 4, status: 'not_found' },
      ],
    })
    expect(target.addAlbum).toHaveBeenCalledExactlyOnceWith(
      { artistMbid: 'mbid-1', artistName: 'Artist 1', releaseGroupMbid: 'rg-1' },
      expect.objectContaining({ userId: 1, recommendationId: 1 }),
    )
    expect(target.addArtist).toHaveBeenCalledExactlyOnceWith(
      { mbid: 'mbid-2', name: 'Artist 2' },
      expect.objectContaining({ userId: 1, recommendationId: 2 }),
    )
    expect(mockDeps.updateRecommendationStatus).toHaveBeenCalledTimes(2)
    expect(mockDeps.updateRecommendationStatus).toHaveBeenCalledWith(
      2,
      'added_to_lidarr',
      expect.objectContaining({ lidarrArtistId: 42 }),
    )
  })

  it('bulk album approval selects an album-only target', async () => {
    mockDeps.getRecommendation.mockResolvedValue({
      userId: 1,
      id: 1,
      kind: 'album',
      recommendedReleaseGroupId: 'rg-1',
      artist: { mbid: 'mbid-1', name: 'Radiohead' },
    })
    const targets = ['lidarr-1', 'lidarr-2'].map((id) => ({
      id,
      type: 'lidarr',
      capabilities: ['addAlbum'],
      addAlbum: vi.fn().mockResolvedValue({ success: true, externalId: 7 }),
    }))
    mockDeps.getEnabledTargetsForUser.mockResolvedValue(targets)

    const res = await createTestApp().request('/api/v1/recommendations/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [1], action: 'approve', targetId: 'lidarr-2' }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ results: [{ id: 1, status: 'added_to_lidarr' }] })
    expect(targets[0]?.addAlbum).not.toHaveBeenCalled()
    expect(targets[1]?.addAlbum).toHaveBeenCalledTimes(1)
  })

  it('bulk approve with createPlaylist-only targets marks all as approved', async () => {
    mockDeps.getRecommendation.mockResolvedValue({
      userId: 1,
      id: 1,
      artist: { mbid: 'mbid-1', name: 'Radiohead' },
    })
    const spotifyTarget = {
      id: 'spotify-playlist-1',
      type: 'spotify-playlist',
      capabilities: ['createPlaylist'],
      openPlaylistExportSession: vi.fn(),
      testConnection: vi.fn(),
    }
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([spotifyTarget])

    const app = createTestApp()
    const res = await app.request('/api/v1/recommendations/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [1], action: 'approve' }),
    })

    const body = await res.json()
    expect(body.results[0].status).toBe('approved')
    expect(spotifyTarget.openPlaylistExportSession).not.toHaveBeenCalled()
  })

  it('returns a per-target summary on partial failure', async () => {
    mockDeps.getRecommendation.mockResolvedValue({
      userId: 1,
      id: 1,
      artist: { mbid: 'mbid-1', name: 'Radiohead' },
    })
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([
      {
        id: 'lidarr-1',
        type: 'lidarr',
        name: 'Lidarr Primary',
        capabilities: ['addArtist'],
        addArtist: vi.fn().mockResolvedValue({ success: true, externalId: 42 }),
      },
      {
        id: 'lidarr-2',
        type: 'lidarr',
        name: 'Lidarr Backup',
        capabilities: ['addArtist'],
        addArtist: vi
          .fn()
          .mockResolvedValue({ success: false, error: 'HTTP 400: invalid profile' }),
      },
    ])

    const app = createTestApp()
    const res = await app.request('/api/v1/recommendations/1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    })

    const body = await res.json()
    expect(body.status).toBe('added_to_lidarr')
    expect(body.targetSummary).toEqual({
      total: 2,
      succeeded: 1,
      failed: 1,
      failures: [{ id: 'lidarr-2', name: 'Lidarr Backup', error: 'HTTP 400: invalid profile' }],
      warnings: [],
    })
  })

  it('retrying a failed target keeps prior successes and does not regress status', async () => {
    // Rec already has lidarr-1 succeeded, lidarr-2 failed.
    mockDeps.getRecommendation.mockResolvedValue({
      userId: 1,
      id: 1,
      artist: { mbid: 'mbid-1', name: 'Radiohead' },
      lidarrArtistId: 42,
      targetActions: {
        'lidarr-1': { status: 'added', externalId: 42 },
        'lidarr-2': { status: 'failed', error: 'connection refused' },
      },
    })
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([
      {
        id: 'lidarr-1',
        type: 'lidarr',
        name: 'Lidarr Primary',
        capabilities: ['addArtist'],
        addArtist: vi.fn().mockResolvedValue({ success: true, externalId: 42 }),
      },
      {
        id: 'lidarr-2',
        type: 'lidarr',
        name: 'Lidarr Backup',
        capabilities: ['addArtist'],
        // Retry fails again.
        addArtist: vi.fn().mockResolvedValue({ success: false, error: 'still down' }),
      },
    ])

    const app = createTestApp()
    const res = await app.request('/api/v1/recommendations/1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved', targetId: 'lidarr-2' }),
    })

    const body = await res.json()
    // lidarr-1 still counts, so the rec is not regressed to add_failed.
    expect(body.status).toBe('added_to_lidarr')
    expect(mockDeps.updateRecommendationStatus).toHaveBeenCalledWith(
      1,
      'added_to_lidarr',
      expect.objectContaining({
        targetActions: expect.objectContaining({
          'lidarr-1': { status: 'added', externalId: 42 },
          'lidarr-2': expect.objectContaining({ status: 'failed' }),
        }),
      }),
    )
    // Summary reflects only this attempt (the retried target).
    expect(body.targetSummary).toEqual({
      total: 1,
      succeeded: 0,
      failed: 1,
      failures: [{ id: 'lidarr-2', name: 'Lidarr Backup', error: 'still down' }],
      warnings: [],
    })
  })
})

describe('track recommendation approval (songpick)', () => {
  beforeEach(() => vi.clearAllMocks())

  const trackRec = (overrides: Record<string, unknown> = {}) => ({
    id: 7,
    userId: 1,
    kind: 'track',
    recommendedRecordingMbid: 'rec-mbid-1',
    recommendedTrackTitle: 'Everything In Its Right Place',
    recommendedTrackAlbum: 'Kid A',
    artist: { mbid: 'mbid-1', name: 'Radiohead' },
    ...overrides,
  })

  const songpickTarget = (result: Record<string, unknown>) => ({
    id: 'songpick-1',
    name: 'songpick',
    type: 'songpick',
    capabilities: ['addTrack'],
    addTrack: vi.fn().mockResolvedValue({ targetType: 'songpick', targetId: 1, ...result }),
  })

  const lidarrTarget = () => ({
    id: 'lidarr-1',
    name: 'Lidarr',
    type: 'lidarr',
    capabilities: ['addArtist', 'addAlbum'],
    addArtist: vi.fn().mockResolvedValue({ success: true, externalId: 42 }),
    addAlbum: vi.fn().mockResolvedValue({ success: true, externalId: 7 }),
  })

  const approve = (body: Record<string, unknown> = {}) =>
    createTestApp().request('/api/v1/recommendations/7', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved', ...body }),
    })

  it('wants the track via songpick only; Lidarr addArtist is never called', async () => {
    mockDeps.getRecommendation.mockResolvedValue(trackRec())
    const lidarr = lidarrTarget()
    const songpick = songpickTarget({
      success: true,
      songpickStatus: 'wanted',
      albumName: 'Kid A',
      edition: 'CD',
    })
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([lidarr, songpick])
    const warm = vi.fn()
    mockDeps.skyhookWarmer = { warm } as never

    try {
      const res = await approve()
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe('approved')
      expect(songpick.addTrack).toHaveBeenCalledExactlyOnceWith(
        {
          artistMbid: 'mbid-1',
          artistName: 'Radiohead',
          title: 'Everything In Its Right Place',
          recordingMbid: 'rec-mbid-1',
        },
        expect.any(Object),
      )
      expect(lidarr.addArtist).not.toHaveBeenCalled()
      expect(lidarr.addAlbum).not.toHaveBeenCalled()
      expect(warm).not.toHaveBeenCalled()
      expect(body.targetActions['songpick-1']).toMatchObject({
        success: true,
        songpickStatus: 'wanted',
        albumName: 'Kid A',
        edition: 'CD',
      })
      expect(body.targetSummary).toMatchObject({ total: 1, succeeded: 1, failed: 0 })
      expect(mockDeps.updateRecommendationStatus).toHaveBeenCalledExactlyOnceWith(
        7,
        'approved',
        expect.objectContaining({
          targetActions: { 'songpick-1': expect.objectContaining({ songpickStatus: 'wanted' }) },
        }),
      )
    } finally {
      mockDeps.skyhookWarmer = null
    }
  })

  it('passes only the approve-dialog root folder override to songpick', async () => {
    mockDeps.getRecommendation.mockResolvedValue(trackRec())
    const songpick = songpickTarget({ success: true, songpickStatus: 'already_wanted' })
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([songpick])

    const res = await approve({ rootFolderId: 3, monitorOption: 'popular' })

    expect((await res.json()).status).toBe('approved')
    const options = songpick.addTrack.mock.calls[0]?.[1]
    expect(options).toMatchObject({ rootFolderId: 3 })
    expect(options).not.toHaveProperty('monitorOption')
    expect(options).not.toHaveProperty('qualityProfileId')
  })

  it('maps songpick owned to duplicate', async () => {
    mockDeps.getRecommendation.mockResolvedValue(trackRec())
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([
      songpickTarget({ success: true, songpickStatus: 'owned' }),
    ])

    const body = await (await approve()).json()

    expect(body.status).toBe('duplicate')
    expect(mockDeps.updateRecommendationStatus).toHaveBeenCalledWith(
      7,
      'duplicate',
      expect.any(Object),
    )
  })

  it('maps a songpick error to add_failed and stores the error text in lidarrError', async () => {
    mockDeps.getRecommendation.mockResolvedValue(trackRec())
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([
      songpickTarget({ success: false, error: 'No Lidarr root folder configured for this user' }),
    ])

    const body = await (await approve()).json()

    expect(body.status).toBe('add_failed')
    expect(body.lidarrError).toBe('No Lidarr root folder configured for this user')
    expect(body.targetActions['songpick-1']).toMatchObject({
      success: false,
      error: 'No Lidarr root folder configured for this user',
    })
    expect(mockDeps.updateRecommendationStatus).toHaveBeenCalledWith(
      7,
      'add_failed',
      expect.objectContaining({ lidarrError: 'No Lidarr root folder configured for this user' }),
    )
  })

  it('fails with no addTrack target instead of silently adding the artist', async () => {
    mockDeps.getRecommendation.mockResolvedValue(trackRec())
    const lidarr = lidarrTarget()
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([lidarr])

    const body = await (await approve()).json()

    expect(body.status).toBe('add_failed')
    expect(body.targetActions).toEqual({})
    expect(body.lidarrError).toEqual(expect.any(String))
    expect(lidarr.addArtist).not.toHaveBeenCalled()
  })

  it('combined_lidarr_slskd mode does not hijack a track rec', async () => {
    mockDeps.getRecommendation.mockResolvedValue(trackRec())
    const lidarr = lidarrTarget()
    const songpick = songpickTarget({ success: true, songpickStatus: 'wanted' })
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([lidarr, songpick])

    const res = await approve({ approvalMode: 'combined_lidarr_slskd', targetId: 'songpick-1' })

    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('approved')
    expect(songpick.addTrack).toHaveBeenCalledOnce()
    expect(lidarr.addArtist).not.toHaveBeenCalled()
  })

  it('accepts an explicit songpick targetId on a track rec', async () => {
    mockDeps.getRecommendation.mockResolvedValue(trackRec())
    const songpick = songpickTarget({ success: true, songpickStatus: 'wanted' })
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([lidarrTarget(), songpick])

    const res = await approve({ targetId: 'songpick-1' })

    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('approved')
    expect(songpick.addTrack).toHaveBeenCalledOnce()
  })

  it('rejects an explicit Lidarr targetId on a track rec', async () => {
    mockDeps.getRecommendation.mockResolvedValue(trackRec())
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([
      lidarrTarget(),
      songpickTarget({ success: true, songpickStatus: 'wanted' }),
    ])

    const res = await approve({ targetId: 'lidarr-1' })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Target does not support track approval: lidarr-1')
    expect(mockDeps.updateRecommendationStatus).not.toHaveBeenCalled()
  })

  it('rejects an explicit songpick targetId on an artist rec', async () => {
    mockDeps.getRecommendation.mockResolvedValue({
      id: 7,
      userId: 1,
      kind: 'artist',
      artist: { mbid: 'mbid-1', name: 'Radiohead' },
    })
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([
      lidarrTarget(),
      songpickTarget({ success: true, songpickStatus: 'wanted' }),
    ])

    const res = await approve({ targetId: 'songpick-1' })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Target does not support artist approval: songpick-1')
  })

  it('bulk approve dispatches a track and an artist rec to their own capability', async () => {
    mockDeps.getRecommendation.mockImplementation(async (id: number) =>
      id === 1
        ? trackRec({ id: 1 })
        : { id, userId: 1, kind: 'artist', artist: { mbid: 'mbid-2', name: 'Portishead' } },
    )
    const lidarr = lidarrTarget()
    const songpick = songpickTarget({ success: true, songpickStatus: 'wanted' })
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([lidarr, songpick])

    const res = await createTestApp().request('/api/v1/recommendations/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [1, 2], action: 'approve', rootFolderId: 2 }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      results: [
        { id: 1, status: 'approved' },
        { id: 2, status: 'added_to_lidarr' },
      ],
    })
    expect(songpick.addTrack).toHaveBeenCalledExactlyOnceWith(
      {
        artistMbid: 'mbid-1',
        artistName: 'Radiohead',
        title: 'Everything In Its Right Place',
        recordingMbid: 'rec-mbid-1',
      },
      expect.objectContaining({ rootFolderId: 2 }),
    )
    expect(lidarr.addArtist).toHaveBeenCalledExactlyOnceWith(
      { mbid: 'mbid-2', name: 'Portishead' },
      expect.objectContaining({ recommendationId: 2 }),
    )
    expect(mockDeps.updateRecommendationStatus).toHaveBeenCalledWith(
      1,
      'approved',
      expect.objectContaining({
        targetActions: { 'songpick-1': expect.objectContaining({ songpickStatus: 'wanted' }) },
      }),
    )
  })

  it('bulk approve accepts a songpick-only targetId', async () => {
    mockDeps.getRecommendation.mockResolvedValue(trackRec({ id: 1 }))
    const songpick = songpickTarget({ success: true, songpickStatus: 'owned' })
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([lidarrTarget(), songpick])

    const res = await createTestApp().request('/api/v1/recommendations/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [1], action: 'approve', targetId: 'songpick-1' }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ results: [{ id: 1, status: 'duplicate' }] })
  })

  it('bulk approve rejects a songpick-only targetId when the batch has an artist rec', async () => {
    mockDeps.getRecommendation.mockResolvedValue({
      id: 2,
      userId: 1,
      kind: 'artist',
      artist: { mbid: 'mbid-2', name: 'Portishead' },
    })
    const songpick = songpickTarget({ success: true, songpickStatus: 'wanted' })
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([lidarrTarget(), songpick])

    const res = await createTestApp().request('/api/v1/recommendations/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [2], action: 'approve', targetId: 'songpick-1' }),
    })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Target does not support artist approval: songpick-1')
    expect(mockDeps.updateRecommendationStatus).not.toHaveBeenCalled()
    expect(songpick.addTrack).not.toHaveBeenCalled()
  })

  it('bulk approve rejects a Lidarr targetId when the batch has a track rec', async () => {
    mockDeps.getRecommendation.mockImplementation(async (id: number) =>
      id === 1
        ? trackRec({ id: 1 })
        : { id, userId: 1, kind: 'artist', artist: { mbid: 'mbid-2', name: 'Portishead' } },
    )
    const lidarr = lidarrTarget()
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([lidarr])

    const res = await createTestApp().request('/api/v1/recommendations/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [2, 1], action: 'approve', targetId: 'lidarr-1' }),
    })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Target does not support track approval: lidarr-1')
    expect(lidarr.addArtist).not.toHaveBeenCalled()
    expect(mockDeps.updateRecommendationStatus).not.toHaveBeenCalled()
  })

  it('bulk approve clears a stale lidarrError on track success', async () => {
    mockDeps.getRecommendation.mockResolvedValue(trackRec({ id: 1, lidarrError: 'old' }))
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([
      songpickTarget({ success: true, songpickStatus: 'wanted' }),
    ])

    await createTestApp().request('/api/v1/recommendations/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [1], action: 'approve' }),
    })

    expect(mockDeps.updateRecommendationStatus).toHaveBeenCalledWith(
      1,
      'approved',
      expect.objectContaining({ lidarrError: null }),
    )
  })

  it('a failed retry keeps a track approved when an earlier songpick want succeeded', async () => {
    mockDeps.getRecommendation.mockResolvedValue(
      trackRec({
        targetActions: {
          'songpick-1': { status: 'added', success: true, songpickStatus: 'wanted' },
        },
      }),
    )
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([
      songpickTarget({ success: false, error: 'songpick timed out' }),
    ])

    const body = await (await approve({ targetId: 'songpick-1' })).json()

    expect(body.status).toBe('approved')
    expect(body.targetSummary).toMatchObject({ total: 1, succeeded: 0, failed: 1 })
    expect(mockDeps.updateRecommendationStatus).toHaveBeenCalledWith(
      7,
      'approved',
      expect.objectContaining({ lidarrError: null }),
    )
  })

  it('a failed bulk retry keeps a track approved and its earlier songpick success', async () => {
    const prior = { status: 'added', success: true, songpickStatus: 'wanted' }
    mockDeps.getRecommendation.mockResolvedValue(
      trackRec({ id: 1, targetActions: { 'songpick-1': prior } }),
    )
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([
      songpickTarget({ success: false, error: 'songpick timed out' }),
    ])

    const res = await createTestApp().request('/api/v1/recommendations/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [1], action: 'approve' }),
    })

    expect(await res.json()).toEqual({ results: [{ id: 1, status: 'approved' }] })
    expect(mockDeps.updateRecommendationStatus).toHaveBeenCalledExactlyOnceWith(
      1,
      'approved',
      expect.objectContaining({ targetActions: { 'songpick-1': prior }, lidarrError: null }),
    )
  })

  it('a failed bulk track approval returns the songpick error per row', async () => {
    mockDeps.getRecommendation.mockResolvedValue(trackRec({ id: 1 }))
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([
      songpickTarget({ success: false, error: 'too many matches' }),
    ])

    const res = await createTestApp().request('/api/v1/recommendations/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [1], action: 'approve' }),
    })

    expect(await res.json()).toEqual({
      results: [
        { id: 1, status: 'add_failed', error: expect.stringContaining('too many matches') },
      ],
    })
  })

  it('a retry with only an owned prior outcome stays duplicate', async () => {
    mockDeps.getRecommendation.mockResolvedValue(
      trackRec({
        targetActions: {
          'songpick-1': { status: 'added', success: true, songpickStatus: 'owned' },
        },
      }),
    )
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([
      songpickTarget({ success: false, error: 'boom' }),
    ])

    expect((await (await approve()).json()).status).toBe('duplicate')
  })
})
