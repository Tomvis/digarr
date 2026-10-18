import { recordFailureSafely } from '@/core/jobs/record-failure-safely'
import type { JobRecorder } from '@/core/jobs/types'
import { errMsg } from '@/core/validation'
import type { DestinationTarget, TargetAddOptions, TrackTargetResult } from './types'

export type TrackApproval = {
  artistMbid: string
  artistName: string
  title: string
  recordingMbid?: string
}

/** Per-target outcome stored in `targetActions`; `status` keeps the shared added/failed contract. */
export type TrackTargetAction = {
  status: 'added' | 'failed'
  success: boolean
  songpickStatus?: TrackTargetResult['songpickStatus']
  albumName?: string
  edition?: string
  error?: string
}

export type TrackApproveResult = {
  status: 'approved' | 'duplicate' | 'add_failed'
  targetActions: Record<string, TrackTargetAction>
  lidarrError?: string
}

const NO_TRACK_TARGET_ERROR = 'No enabled songpick target to want this track'
const MISSING_TRACK_TITLE_ERROR = 'Track recommendation has no track title'

function toAction(result: TrackTargetResult): TrackTargetAction {
  return {
    status: result.success ? 'added' : 'failed',
    success: result.success,
    ...(result.songpickStatus ? { songpickStatus: result.songpickStatus } : {}),
    ...(result.albumName ? { albumName: result.albumName } : {}),
    ...(result.edition ? { edition: result.edition } : {}),
    ...(result.error ? { error: result.error } : {}),
  }
}

/**
 * Wants one track through every enabled addTrack (songpick) target. Status:
 * any wanted/already_wanted → approved; else owned → duplicate; else
 * add_failed with the first error text in lidarrError. Never falls back to
 * an artist add.
 */
export async function approveTrackToTargets(
  track: TrackApproval,
  targets: DestinationTarget[],
  addOptions: TargetAddOptions,
  jobRecorder?: JobRecorder,
  userId?: number,
  recommendationId?: number,
): Promise<TrackApproveResult> {
  const actionable = targets.filter(
    (t) => t.capabilities?.includes('addTrack') && typeof t.addTrack === 'function',
  )
  if (actionable.length === 0) {
    return { status: 'add_failed', targetActions: {}, lidarrError: NO_TRACK_TARGET_ERROR }
  }

  const targetActions: Record<string, TrackTargetAction> = {}
  let wanted = false
  let owned = false
  let firstError: string | undefined

  for (const target of actionable) {
    const metadata = {
      targetType: target.type,
      artistName: track.artistName,
      mbid: track.artistMbid,
      trackTitle: track.title,
      ...(track.recordingMbid ? { recordingMbid: track.recordingMbid } : {}),
      action: 'addTrack',
    }
    const jobId = jobRecorder ? await jobRecorder.start({ type: 'target', userId, metadata }) : null

    let result: TrackTargetResult
    try {
      result = (await target.addTrack?.(track, { ...addOptions, userId, recommendationId })) ?? {
        success: false,
        targetType: target.type,
        targetId: 0,
        error: 'Target returned no result',
      }
    } catch (err) {
      result = { success: false, targetType: target.type, targetId: 0, error: errMsg(err) }
    }

    targetActions[target.id] = toAction(result)
    if (result.success) {
      if (result.songpickStatus === 'owned') owned = true
      else wanted = true
    } else {
      firstError ??= result.error ?? 'Target returned failure'
    }

    if (jobId != null && jobRecorder) {
      if (result.success) {
        await jobRecorder.complete(jobId, {
          metadata: { ...metadata, songpickStatus: result.songpickStatus },
        })
      } else {
        await recordFailureSafely(jobRecorder, jobId, result.error ?? 'Target returned failure')
      }
    }
  }

  if (wanted) return { status: 'approved', targetActions }
  if (owned) return { status: 'duplicate', targetActions }
  return { status: 'add_failed', targetActions, lidarrError: firstError }
}

export type TrackRecommendation = {
  id: number
  artist: { mbid: string; name: string }
  recommendedTrackTitle?: string | null
  recommendedRecordingMbid?: string | null
}

/** approveTrackToTargets for a track-kind rec row; a row without a title fails closed. */
export async function approveTrackRecommendation(
  rec: TrackRecommendation,
  targets: DestinationTarget[],
  addOptions: TargetAddOptions,
  jobRecorder?: JobRecorder,
  userId?: number,
): Promise<TrackApproveResult> {
  if (!rec.recommendedTrackTitle) {
    return { status: 'add_failed', targetActions: {}, lidarrError: MISSING_TRACK_TITLE_ERROR }
  }
  return approveTrackToTargets(
    {
      artistMbid: rec.artist.mbid,
      artistName: rec.artist.name,
      title: rec.recommendedTrackTitle,
      ...(rec.recommendedRecordingMbid ? { recordingMbid: rec.recommendedRecordingMbid } : {}),
    },
    targets,
    addOptions,
    jobRecorder,
    userId,
    rec.id,
  )
}
