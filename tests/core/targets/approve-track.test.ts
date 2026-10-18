// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  approveTrackRecommendation,
  approveTrackToTargets,
  deriveTrackStatus,
  mergeTrackActions,
} from '@/core/targets/approve-track'
import type { DestinationTarget } from '@/core/targets/types'

const track = { artistMbid: 'a-1', artistName: 'Portishead', title: 'Roads', recordingMbid: 'r-1' }

function target(id: string, addTrack: DestinationTarget['addTrack']): DestinationTarget {
  return {
    id,
    name: id,
    type: 'songpick',
    capabilities: ['addTrack'],
    addTrack,
    testConnection: vi.fn(),
  }
}

describe('approveTrackToTargets', () => {
  it('records a throwing target as a failed action', async () => {
    const result = await approveTrackToTargets(
      track,
      [target('songpick-1', vi.fn().mockRejectedValue(new Error('socket hang up')))],
      {},
    )

    expect(result).toEqual({
      status: 'add_failed',
      targetActions: {
        'songpick-1': { status: 'failed', success: false, error: 'socket hang up' },
      },
      lidarrError: 'socket hang up',
    })
  })

  it('approves when one of two targets wants the track and the other fails', async () => {
    const result = await approveTrackToTargets(
      track,
      [
        target('songpick-1', vi.fn().mockResolvedValue({ success: false, error: 'down' })),
        target(
          'songpick-2',
          vi.fn().mockResolvedValue({ success: true, songpickStatus: 'already_wanted' }),
        ),
      ],
      {},
    )

    expect(result.status).toBe('approved')
    expect(result.lidarrError).toBeUndefined()
    expect(result.targetActions).toEqual({
      'songpick-1': { status: 'failed', success: false, error: 'down' },
      'songpick-2': { status: 'added', success: true, songpickStatus: 'already_wanted' },
    })
  })

  it('is duplicate when one target reports owned and the other fails', async () => {
    const result = await approveTrackToTargets(
      track,
      [
        target('songpick-1', vi.fn().mockResolvedValue({ success: true, songpickStatus: 'owned' })),
        target('songpick-2', vi.fn().mockResolvedValue({ success: false, error: 'down' })),
      ],
      {},
    )

    expect(result.status).toBe('duplicate')
    expect(result.lidarrError).toBeUndefined()
  })

  it('records a target job per attempt', async () => {
    const recorder = {
      start: vi.fn().mockResolvedValue(5),
      complete: vi.fn(),
      fail: vi.fn(),
      cancel: vi.fn(),
      markStuck: vi.fn(),
    }
    await approveTrackToTargets(
      track,
      [
        target(
          'songpick-1',
          vi.fn().mockResolvedValue({ success: true, songpickStatus: 'wanted' }),
        ),
      ],
      {},
      recorder as never,
      3,
      9,
    )

    expect(recorder.start).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'target',
        userId: 3,
        metadata: expect.objectContaining({ action: 'addTrack', recordingMbid: 'r-1' }),
      }),
    )
    expect(recorder.complete).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ metadata: expect.objectContaining({ songpickStatus: 'wanted' }) }),
    )
  })
})

describe('approveTrackRecommendation', () => {
  it('fails closed for a row without a track title, without calling any target', async () => {
    const addTrack = vi.fn()
    const result = await approveTrackRecommendation(
      { id: 1, artist: { mbid: 'a-1', name: 'Portishead' }, recommendedTrackTitle: null },
      [target('songpick-1', addTrack)],
      {},
    )

    expect(result).toEqual({
      status: 'add_failed',
      targetActions: {},
      lidarrError: 'Track recommendation has no track title',
    })
    expect(addTrack).not.toHaveBeenCalled()
  })
})

describe('deriveTrackStatus', () => {
  it('prefers a want over owned over failures', () => {
    expect(
      deriveTrackStatus({
        a: { success: true, songpickStatus: 'owned' },
        b: { success: true, songpickStatus: 'wanted' },
      }),
    ).toBe('approved')
    expect(deriveTrackStatus({ a: { success: true, songpickStatus: 'owned' }, b: null })).toBe(
      'duplicate',
    )
    expect(deriveTrackStatus({ a: { success: false, error: 'x' } })).toBe('add_failed')
    expect(deriveTrackStatus({})).toBe('add_failed')
  })
})

describe('mergeTrackActions', () => {
  it('keeps an earlier success over a failed retry on the same target, takes everything else', () => {
    const prior = {
      'songpick-1': { status: 'added', success: true, songpickStatus: 'wanted' },
      'songpick-2': { status: 'failed', success: false, error: 'old' },
    }
    expect(
      mergeTrackActions(prior, {
        'songpick-1': { status: 'failed', success: false, error: 'timeout' },
        'songpick-2': { status: 'added', success: true, songpickStatus: 'owned' },
      }),
    ).toEqual({
      'songpick-1': { status: 'added', success: true, songpickStatus: 'wanted' },
      'songpick-2': { status: 'added', success: true, songpickStatus: 'owned' },
    })
  })
})
