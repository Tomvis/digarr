/**
 * Seconds a caller should wait when `err` means MusicBrainz itself is down or
 * shedding load (MUSIC-175); null for anything else, which stays a digarr bug.
 *
 * Matches on error names rather than `instanceof` so the top-level onError does
 * not depend on the musicbrainz client module, which many tests replace wholesale.
 */
export function musicBrainzOutageRetryAfter(err: unknown): number | null {
  if (!(err instanceof Error)) return null
  if (err.name === 'MusicBrainzCircuitOpenError' && 'retryAtMs' in err) {
    return Math.max(1, Math.ceil((Number(err.retryAtMs) - Date.now()) / 1000))
  }
  if (err.name === 'MusicBrainzHttpError' && 'status' in err) {
    const status = Number(err.status)
    if (status === 429 || status >= 500) return 60
  }
  return null
}
