import { cellSafe } from '@/core/csv/cell-safe'
import type { ExportableRecommendation } from './types'

export function exportToCsv(recommendations: ExportableRecommendation[]): string {
  // Track columns only appear when a track rec is present, keeping the artist/album format stable.
  const hasTracks = recommendations.some((r) => r.trackTitle)
  const header = `artist,mbid,genres,score,status,date${hasTracks ? ',track,track_album' : ''}`
  const rows = recommendations.map((r) =>
    [
      cellSafe(r.artistName),
      cellSafe(r.artistMbid),
      cellSafe(r.genres.join(';')),
      cellSafe(r.score.toFixed(2)),
      cellSafe(r.status),
      cellSafe(r.createdAt),
      ...(hasTracks ? [cellSafe(r.trackTitle ?? ''), cellSafe(r.trackAlbum ?? '')] : []),
    ].join(','),
  )
  return [header, ...rows].join('\n')
}
