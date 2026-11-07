// @vitest-environment node

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearAllSessions, createSession } from '@/core/sessions'
import type { DestinationTarget } from '@/core/targets/types'
import type { AppDependencies } from '@/server'
import { createApp } from '@/server'

// Fork (HERMES-55): POST /api/v1/recommendations/add-artist.
const mbid = '9c9f1380-2516-4fc9-a3e6-f9f61941d090'
const path = '/api/v1/recommendations/add-artist'

function target(
  id: string,
  type: DestinationTarget['type'] = 'lidarr',
  addArtist = vi.fn().mockResolvedValue({ success: true, externalId: 99 }),
) {
  return {
    id,
    name: id,
    type,
    capabilities: ['addArtist', 'addAlbum'],
    addArtist,
    testConnection: vi.fn(),
  } satisfies DestinationTarget
}

function makeApp(overrides: Partial<AppDependencies> = {}) {
  const deps = {
    orchestrator: new EventEmitter(),
    isSetupComplete: vi.fn(async () => true),
    getUserCount: vi.fn(async () => 1),
    getUserById: vi.fn(async () => ({ id: 7, isAdmin: false, approvalPolicy: 'direct' })),
    getSettings: vi.fn(async () => ({})),
    getEnabledTargetsForUser: vi.fn(async () => [target('lidarr-1')]),
    ...overrides,
  } as unknown as AppDependencies
  return { app: createApp(deps), deps }
}

async function post(app: ReturnType<typeof createApp>, body: unknown) {
  await createSession(7, 'add-artist-session')
  return app.request(path, {
    method: 'POST',
    headers: { Authorization: 'Bearer add-artist-session', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

afterEach(async () => {
  await clearAllSessions()
  vi.restoreAllMocks()
})

describe('POST /api/v1/recommendations/add-artist', () => {
  it("adds through the caller's own Lidarr targets only, with the chosen monitor option", async () => {
    const lidarr = target('lidarr-1')
    const slskd = target('slskd-2', 'slskd')
    const { app, deps } = makeApp({
      getEnabledTargetsForUser: vi.fn(async () => [lidarr, slskd]),
    })
    const res = await post(app, { mbid: mbid.toUpperCase(), name: 'Muse', monitorOption: 'all' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      mbid,
      name: 'Muse',
      monitorOption: 'all',
      success: true,
      lidarrArtistId: 99,
      targetActions: { 'lidarr-1': { status: 'added' } },
    })
    expect(deps.getEnabledTargetsForUser).toHaveBeenCalledWith(7)
    expect(lidarr.addArtist).toHaveBeenCalledWith(
      { mbid, name: 'Muse' },
      expect.objectContaining({ monitorOption: 'all', retryExisting: true, userId: 7 }),
    )
    expect(slskd.addArtist).not.toHaveBeenCalled()
  })

  it('reports a failed add without leaking the error detail', async () => {
    const failing = target(
      'lidarr-1',
      'lidarr',
      vi.fn().mockResolvedValue({ success: false, error: 'upstream apiKey=private-value' }),
    )
    const { app } = makeApp({ getEnabledTargetsForUser: vi.fn(async () => [failing]) })
    const res = await post(app, { mbid, name: 'Muse', monitorOption: 'none' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(JSON.stringify(body)).not.toContain('private-value')
  })

  it('refuses request-only users and users without a Lidarr target', async () => {
    const requestOnly = makeApp({
      getUserById: vi.fn(async () => ({
        id: 7,
        isAdmin: false,
        approvalPolicy: 'request_only',
      })) as unknown as AppDependencies['getUserById'],
    })
    expect((await post(requestOnly.app, { mbid, name: 'Muse', monitorOption: 'all' })).status).toBe(
      403,
    )
    const noLidarr = makeApp({
      getEnabledTargetsForUser: vi.fn(async () => [target('slskd-2', 'slskd')]),
    })
    expect((await post(noLidarr.app, { mbid, name: 'Muse', monitorOption: 'all' })).status).toBe(
      400,
    )
  })

  it("rejects 'selected' and malformed input", async () => {
    const { app } = makeApp()
    for (const body of [
      { mbid, name: 'Muse', monitorOption: 'selected' },
      { mbid: 'not-a-uuid', name: 'Muse', monitorOption: 'all' },
      { mbid, name: '', monitorOption: 'all' },
      { mbid, name: 'Muse' },
    ]) {
      expect((await post(app, body)).status).toBe(400)
    }
  })
})
