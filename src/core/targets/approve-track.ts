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

/**
 * Rec status from a (possibly merged) targetActions map: any wanted /
 * already_wanted success → approved; else any owned → duplicate; else add_failed.
 */
export function deriveTrackStatus(actions: Record<string, unknown>): TrackApproveResult['status'] {
  const successes = Object.values(actions).filter(
    (a): a is Partial<TrackTargetAction> =>
      typeof a === 'object' && a !== null && (a as TrackTargetAction).success === true,
  )
  if (successes.some((a) => a.songpickStatus !== 'owned')) return 'approved'
  if (successes.length > 0) return 'duplicate'
  return 'add_failed'
}

/**
 * Merge a retry's actions over the stored ones. A failed retry never replaces
 * an earlier success on the same target: songpick's want already happened in
 * Lidarr and a later failure does not undo it.
 */
export function mergeTrackActions(
  prior: Record<string, unknown>,
  next: Record<string, TrackTargetAction>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...prior }
  for (const [id, action] of Object.entries(next)) {
    const before = prior[id] as Partial<TrackTargetAction> | null | undefined
    if (!action.success && before?.success === true) continue
    merged[id] = action
  }
  return merged
}

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
    if (!result.success) firstError ??= result.error ?? 'Target returned failure'

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

  const status = deriveTrackStatus(targetActions)
  return status === 'add_failed'
    ? { status, targetActions, lidarrError: firstError }
    : { status, targetActions }
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
