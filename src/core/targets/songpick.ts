import { createSongpickClient, SongpickError } from '@/core/clients/songpick'
import type { ServiceTestResult } from '@/core/types'
import { errMsg } from '@/core/validation'
import type { DestinationTarget, TargetAddOptions, TrackTargetResult } from './types'

export type SongpickTargetConfig = {
  name?: string
  url: string
  resolveRootFolderPath: (rootFolderId?: number) => Promise<string | undefined>
  timeoutMs?: number
}

/** Override wins, then the user's pref; no id or an unknown id yields undefined. */
export function pickRootFolderPath(
  folders: { id: number; path: string }[],
  override?: number,
  userPref?: number | string | null,
): string | undefined {
  const wanted = override ?? userPref
  if (wanted == null || wanted === '') return undefined
  return folders.find((f) => f.id === Number(wanted))?.path
}

export function createSongpickTarget(id: number, cfg: SongpickTargetConfig): DestinationTarget {
  const client = createSongpickClient(cfg.url, { timeoutMs: cfg.timeoutMs })
  const fail = (error: string): TrackTargetResult => ({
    success: false,
    targetType: 'songpick',
    targetId: id,
    error,
  })

  return {
    id: `songpick-${id}`,
    name: cfg.name ?? 'songpick',
    type: 'songpick',
    capabilities: ['addTrack'],

    async addTrack(
      track: { artistMbid: string; artistName: string; title: string; recordingMbid?: string },
      options?: TargetAddOptions,
    ): Promise<TrackTargetResult> {
      try {
        const rootFolder = await cfg.resolveRootFolderPath(options?.rootFolderId)
        if (!rootFolder) return fail('No Lidarr root folder configured for this user')
        const res = await client.want({
          root_folder: rootFolder,
          artist_name: track.artistName,
          artist_mbid: track.artistMbid,
          track_name: track.title,
          recording_mbid: track.recordingMbid,
        })
        return {
          success: true,
          targetType: 'songpick',
          targetId: id,
          songpickStatus: res.status,
          albumName: res.album_name ?? undefined,
          edition: res.edition ?? undefined,
        }
      } catch (err: unknown) {
        return fail(err instanceof SongpickError ? err.message : errMsg(err))
      }
    },

    testConnection(): Promise<ServiceTestResult> {
      return client.health()
    },
  }
}
