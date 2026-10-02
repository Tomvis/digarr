// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { prefilterCandidates } from '@/core/pipeline/prefilter'
import type { DiscoveredArtist } from '@/core/types'

const d = (name: string, over: Partial<DiscoveredArtist> = {}): DiscoveredArtist => ({
  name,
  mbid: `mb-${name}`,
  similarityScore: 0.5,
  source: 'lastfm',
  ...over,
})

const none = { excludeMbids: new Set<string>(), excludeNames: new Set<string>(), limit: null }

describe('prefilterCandidates', () => {
  it('drops artists already owned/recommended/rejected (by mbid) or top artists (by name)', () => {
    const result = prefilterCandidates([d('Owned'), d('Top', { mbid: undefined }), d('New')], {
      excludeMbids: new Set(['mb-Owned']),
      excludeNames: new Set(['top']),
      limit: null,
    })
    expect(result.kept.map((a) => a.name)).toEqual(['New'])
    expect(result.droppedKnown).toBe(2)
  })

  it('caps distinct artists, ranking multi-source and more similar ones first', () => {
    const result = prefilterCandidates(
      [
        d('Weak', { similarityScore: 0.2 }),
        d('Strong', { similarityScore: 0.9 }),
        d('Consensus', { similarityScore: 0.3 }),
        d('Consensus', { similarityScore: 0.3, source: 'listenbrainz' }),
      ],
      { ...none, limit: 2 },
    )
    expect([...new Set(result.kept.map((a) => a.name))]).toEqual(['Consensus', 'Strong'])
    // Both discoveries of a kept artist survive, so consensus still scores.
    expect(result.kept.filter((a) => a.name === 'Consensus')).toHaveLength(2)
    expect(result.droppedByCap).toBe(1)
  })

  it('never drops album candidates or AI album suggestions for owned artists', () => {
    const result = prefilterCandidates(
      [
        d('Owned A', { releaseGroupMbid: 'rg-1' }),
        d('Owned B', { source: 'ai', suggestedAlbum: 'New Record' }),
        d('Owned C'),
      ],
      {
        excludeMbids: new Set(['mb-Owned A', 'mb-Owned B', 'mb-Owned C']),
        excludeNames: new Set(),
        limit: 0,
      },
    )
    expect(result.kept.map((a) => a.name).sort()).toEqual(['Owned A', 'Owned B'])
  })
})
