import { Cron } from 'croner'
import { isMaintenance } from '@/core/ops/maintenance'

export type MusicRaterSyncSchedulerDeps = {
  /** IDs of users with both `musicRaterUrl` and `musicRaterApiKey` set. */
  listSyncableUserIds: () => Promise<number[]>
  /**
   * Run and record the sync for one user. Implementations record the run
   * via `createJobRecorder` and rethrow on failure (see `executeMusicRaterSync`
   * in `src/index.ts`) -- that rethrow is what makes a failure visible in Job
   * History. This scheduler catches it anyway, per user, purely so one user's
   * unreachable music-rater instance cannot stop the next user's sync within
   * the same tick.
   */
  syncUser: (userId: number) => Promise<void>
}

/**
 * Nightly per-user music-rater corpus sync.
 *
 * Fixed cadence (not driven by a settings field, unlike
 * `library/scheduler.ts`'s `librarySyncIntervalHours`): once a day is plenty
 * for a corpus that only grows as the user rates more albums, and there is
 * no existing per-integration interval setting to hang this off without
 * adding new settings-UI surface that Task 5 does not otherwise need.
 * 04:00 runs clear of the weekly pipeline default (Sunday 00:00) and the
 * every-10-minute slskd poll, after most nights' library maintenance ticks
 * (`library/scheduler.ts`, `library/health-scheduler.ts`, default 6h
 * interval) so Task 6/7 read a same-night-fresh corpus during the day.
 *
 * Joins the existing schedulers registered in `src/index.ts`'s boot sequence
 * (pipeline/subscription `SubscriptionScheduler`, `PlaylistScheduler`,
 * `startLibrarySyncScheduler`, `startLibraryHealthScheduler`,
 * `startStuckDetector`, `startDigestNotifier`).
 */
export function startMusicRaterSyncScheduler(deps: MusicRaterSyncSchedulerDeps): Cron {
  const pattern = '0 4 * * *'
  console.log(`[music-rater-scheduler] started, pattern="${pattern}"`)
  return new Cron(pattern, async () => {
    if (isMaintenance()) {
      console.log('[music-rater-scheduler] tick skipped: maintenance in progress')
      return
    }
    const userIds = await deps.listSyncableUserIds()
    for (const userId of userIds) {
      try {
        await deps.syncUser(userId)
      } catch (err: unknown) {
        console.error(`[music-rater-scheduler] sync failed for user ${userId}:`, err)
      }
    }
  })
}
