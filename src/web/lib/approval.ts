import { toast } from 'sonner'
import type { MessageKey } from '@/core/i18n/messages/types'
import type { ApprovalResponse, LidarrRemovalSkipReason } from './api'

type Translate = (key: MessageKey) => string

const REMOVAL_SKIPPED_MESSAGE: Record<LidarrRemovalSkipReason, MessageKey> = {
  not_added_by_digarr: 'discover.undoneLidarrNotAdded',
  has_files: 'discover.undoneLidarrHasFiles',
  removal_failed: 'discover.undoneLidarrRemovalFailed',
}

/**
 * The undo toast has to say what actually happened to the Lidarr artist:
 * "Undone" alone would imply a clean reversal even when the artist is still
 * there because it already has downloaded files or because Lidarr errored.
 */
export function undoOutcomeMessage(res: ApprovalResponse): MessageKey {
  if (res.lidarrArtistRemoved) return 'discover.undoneLidarrRemoved'
  const reason = res.lidarrRemovalSkippedReason
  // hasOwn, not `in`: an unknown reason string must not resolve to an
  // inherited Object.prototype member and be handed to `t()` as a key.
  if (reason && Object.hasOwn(REMOVAL_SKIPPED_MESSAGE, reason))
    return REMOVAL_SKIPPED_MESSAGE[reason]
  // Nothing was attempted (a plain status revert): no Lidarr claim to make.
  return 'discover.undone'
}

/**
 * Surface the per-target outcome of an approve attempt at submit time.
 * Returns true when every attempted target succeeded (caller runs its normal
 * success path); returns false after showing a partial/total-failure toast.
 */
export function reportApprovalOutcome(res: ApprovalResponse, t: Translate): boolean {
  const summary = res.targetSummary
  if (summary && summary.total > 0 && summary.failed > 0) {
    const names = summary.failures.map((f) => f.name).join(', ')
    if (summary.succeeded > 0) {
      toast.warning(
        t('discover.approvePartial')
          .replace('{0}', String(summary.succeeded))
          .replace('{1}', String(summary.total))
          .replace('{2}', names),
      )
    } else {
      toast.error(t('discover.approveAllFailed').replace('{0}', names))
    }
    return false
  }
  // No target summary (discovery-only / no actionable targets) but the server
  // still reports a failed add.
  if (res.status === 'add_failed') {
    toast.error(t('dashboard.approveFailed'))
    return false
  }
  // Full success, but a target reported a non-fatal partial outcome (e.g. the
  // artist was added but the selected album could not be monitored yet).
  if (summary?.warnings?.length) {
    toast.warning(summary.warnings.join('; '))
  }
  return true
}
