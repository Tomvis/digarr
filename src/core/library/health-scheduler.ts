import { Cron } from 'croner'
import { musicBrainzDeferralReason } from '@/core/clients/musicbrainz'
import { isMaintenance } from '@/core/ops/maintenance'
import { buildCronPattern } from './scheduler'

export type LibraryHealthSchedulerDeps = {
  intervalHours: number
  libraryHealth: {
    startScan: () => void
  }
  // Scheduled scans are Lidarr-only; discovery-only installs skip them instead of failing every tick.
  isConfigured: () => Promise<boolean>
}

export function startLibraryHealthScheduler(deps: LibraryHealthSchedulerDeps): Cron {
  const pattern = buildCronPattern(deps.intervalHours)
  console.log(
    `[library-health-scheduler] started, interval=${deps.intervalHours}h, pattern="${pattern}"`,
  )
  return new Cron(pattern, async () => {
    if (isMaintenance()) {
      console.log('[library-health-scheduler] tick skipped: maintenance in progress')
      return
    }
    // The health scan is long and MusicBrainz-heavy, and it runs at process
    // start as well as on this schedule -- so a `docker restart` does not stop
    // it. Starting one against an exhausted budget, or while the client's
    // circuit breaker is armed, can only produce `leaving unreconciled` rows
    // while pushing the shared household budget further down. Skip loudly and
    // wait for the next tick; an operator can still scan on demand from the UI.
    const deferral = musicBrainzDeferralReason()
    if (deferral) {
      console.log(`[library-health-scheduler] tick skipped: ${deferral}`)
      return
    }
    try {
      if (!(await deps.isConfigured())) return
      deps.libraryHealth.startScan()
    } catch (err: unknown) {
      console.error('[library-health-scheduler] tick failed:', err)
    }
  })
}
