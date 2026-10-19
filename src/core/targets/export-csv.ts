import { cellSafe } from '@/core/csv/cell-safe'
import type { ExportableRecommendation } from './types'

export function exportToCsv(recommendations: ExportableRecommendation[]): string {
  // Fork track columns only appear when a track rec is present, keeping upstream's format stable.
  const hasTracks = recommendations.some((r) => r.trackTitle)
  const header = `artist,mbid,genres,score,status,date,recording_mbid,recording_title${hasTracks ? ',track,track_album' : ''}`
  const rows = recommendations.map((r) =>
    [
      cellSafe(r.artistName),
      cellSafe(r.artistMbid),
      cellSafe(r.genres.join(';')),
      cellSafe(r.score.toFixed(2)),
      cellSafe(r.status),
      cellSafe(r.createdAt),
      cellSafe(r.recordingMbid ?? ''),
      cellSafe(r.recordingTitle ?? ''),
      ...(hasTracks ? [cellSafe(r.trackTitle ?? ''), cellSafe(r.trackAlbum ?? '')] : []),
    ].join(','),
  )
  return [header, ...rows].join('\n')
}
