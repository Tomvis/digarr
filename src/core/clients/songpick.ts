import type { ServiceTestResult } from '@/core/types'
import { errMsg } from '@/core/validation'
import { CHROME_USER_AGENT } from './user-agent'

export type SongpickRequest = {
  root_folder: string
  artist_name: string
  artist_mbid?: string
  track_name: string
  recording_mbid?: string
}

export type SongpickResponse = {
  status: 'owned' | 'already_wanted' | 'wanted'
  reason?: string
  artist_name?: string
  album_name?: string
  track_name?: string
  release_group_mbid?: string
  release_mbid?: string
  dr?: number | null
  edition?: string | null
  artist_added?: boolean
}

export class SongpickError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'SongpickError'
  }
}

// songpick serializes requests server-side; one call can take minutes.
export const SONGPICK_DEFAULT_TIMEOUT_MS = 15 * 60_000

export function createSongpickClient(
  url: string,
  opts: { timeoutMs?: number; fetch?: typeof fetch } = {},
) {
  const base = url.replace(/\/+$/, '')
  const doFetch = opts.fetch ?? fetch
  const timeoutMs = opts.timeoutMs ?? SONGPICK_DEFAULT_TIMEOUT_MS

  return {
    async want(req: SongpickRequest): Promise<SongpickResponse> {
      const res = await doFetch(`${base}/song`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': CHROME_USER_AGENT },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await res.text()
      let body: unknown
      try {
        body = text ? JSON.parse(text) : undefined
      } catch {
        body = undefined
      }
      if (!res.ok) {
        const error = (body as { error?: unknown } | undefined)?.error
        throw new SongpickError(
          res.status,
          typeof error === 'string' && error ? error : `songpick returned HTTP ${res.status}`,
        )
      }
      const status = (body as { status?: unknown } | undefined)?.status
      if (typeof status !== 'string') {
        throw new SongpickError(res.status, 'songpick returned an invalid response')
      }
      return body as SongpickResponse
    },

    async health(): Promise<ServiceTestResult> {
      try {
        const res = await doFetch(`${base}/health`, {
          headers: { 'User-Agent': CHROME_USER_AGENT },
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) return { success: false, message: `songpick returned HTTP ${res.status}` }
        return { success: true, message: 'Connected to songpick' }
      } catch (err) {
        return { success: false, message: errMsg(err) }
      }
    },
  }
}
