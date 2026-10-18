import { parseYear } from '@/core/clients/musicbrainz'
import { checkPipelineCancelled, PipelineCancelledError } from '@/core/pipeline/cancel'
import type { StoreDb, StoreOptions } from '@/core/pipeline/store'
import type { MusicBrainzClient } from '@/core/subscriptions/types'
import type { DiscoveredTrack } from '@/core/types'

export type ScoredTrack = DiscoveredTrack & { score: number }

type SelectOptions = {
  known: Set<string>
  isOwned?: (artistName: string, title: string) => Promise<boolean>
  threshold: number
  cap?: number
}

/** Earlier playlist positions score higher: 0.85 at the top, falling by 0.3 across the list. */
function trackScore(position: number, total: number): number {
  return 0.85 - (0.3 * position) / Math.max(total, 1)
}

/**
 * Dedupe, score, threshold and owned-filter discovered tracks. Owned checks run
 * best-first and stop once `cap` tracks are kept, so they are not wasted on
 * tracks that would be cut anyway.
 */
export async function selectTracks(
  tracks: DiscoveredTrack[],
  opts: SelectOptions,
): Promise<ScoredTrack[]> {
  const seen = new Set<string>()
  const candidates: ScoredTrack[] = []
  for (const t of tracks) {
    if (!t.recordingMbid || !t.artistMbid) continue
    if (seen.has(t.recordingMbid) || opts.known.has(t.recordingMbid)) continue
    seen.add(t.recordingMbid)
    const score = trackScore(t.position, t.total)
    if (score < opts.threshold) continue
    candidates.push({ ...t, score })
  }
  candidates.sort((a, b) => b.score - a.score)

  const kept: ScoredTrack[] = []
  for (const t of candidates) {
    if (opts.cap !== undefined && kept.length >= opts.cap) break
    if (opts.isOwned) {
      try {
        if (await opts.isOwned(t.artistName, t.title)) continue
      } catch (err: unknown) {
        console.warn(`[subscription-tracks] owned check failed for "${t.title}":`, err)
      }
    }
    kept.push(t)
  }
  return kept
}

type ArtistData = Parameters<StoreDb['upsertArtist']>[0]

async function buildArtistData(
  mb: MusicBrainzClient,
  mbid: string,
  fallbackName: string,
): Promise<ArtistData> {
  const mbArtist = await mb.lookupArtist(mbid)
  const tags = (mbArtist.tags ?? []).map((t) => t.name)
  return {
    mbid,
    name: mbArtist.name ?? fallbackName,
    disambiguation: mbArtist.disambiguation,
    tags,
    genres: tags,
    streamingUrls: mb.extractStreamingUrls(mbArtist.relations ?? []),
    beginYear: parseYear(mbArtist['life-span']?.begin),
    endYear: parseYear(mbArtist['life-span']?.end),
  }
}

/** Store track recommendations; each gets an artist row (upserted once per artist MBID). */
export async function storeTracks(
  tracks: ScoredTrack[],
  db: StoreDb,
  mb: MusicBrainzClient,
  options: StoreOptions = {},
): Promise<{ batchId: number; added: number }> {
  checkPipelineCancelled(options.signal)
  const batch = await db.insertBatch({
    status: 'running',
    stats: { total: tracks.length, createdAt: new Date().toISOString() },
    subscriptionId: options.subscriptionId,
  })

  let added = 0
  let failed = 0
  const artistIds = new Map<string, number>()
  const failedArtists = new Map<string, unknown>()

  try {
    for (const t of tracks) {
      checkPipelineCancelled(options.signal)
      const artistMbid = t.artistMbid as string
      try {
        if (failedArtists.has(artistMbid)) throw failedArtists.get(artistMbid)
        let artistId = artistIds.get(artistMbid)
        if (artistId === undefined) {
          try {
            // Existing rows keep their curated genres/streaming data untouched.
            artistId = (await db.getArtistIdByMbid?.(artistMbid)) ?? undefined
            if (artistId === undefined) {
              const artistData = await buildArtistData(mb, artistMbid, t.artistName)
              artistId = (await db.upsertArtist(artistData)).id
            }
          } catch (artistErr) {
            failedArtists.set(artistMbid, artistErr)
            throw artistErr
          }
          artistIds.set(artistMbid, artistId)
        }
        await db.insertRecommendation({
          artistId,
          batchId: batch.id,
          score: t.score,
          sources: { [t.source]: t.score },
          status: 'pending',
          userId: options.userId,
          kind: 'track',
          recommendedRecordingMbid: t.recordingMbid,
          recommendedTrackTitle: t.title,
          recommendedTrackAlbum: t.album,
          recommendedCoverReleaseMbid: t.coverReleaseMbid,
        })
        added++
      } catch (err: unknown) {
        if (err instanceof PipelineCancelledError || options.signal?.aborted) throw err
        failed++
        console.error(`Failed to store track ${t.recordingMbid}:`, err)
      }
    }

    checkPipelineCancelled(options.signal)
    await db.completeBatch(batch.id, { discovered: tracks.length, added, failed })
    return { batchId: batch.id, added }
  } catch (err) {
    try {
      await db.failBatch(batch.id)
    } catch (cleanupError) {
      console.error('Failed to mark track batch failed:', cleanupError)
    }
    throw err
  }
}
