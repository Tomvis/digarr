import { createListenBrainzClient } from '@/core/clients/listenbrainz'
import type { DiscoverySource } from './types'

export function createListenBrainzSource(username: string, token: string): DiscoverySource {
  const client = createListenBrainzClient(username, token)

  return {
    id: 'listenbrainz',
    name: 'ListenBrainz',
    capabilities: ['topArtists', 'similarArtists', 'listeningActivity'],

    async getTopArtists() {
      // A quiet month (or a new account) has no stats; the year still says
      // something about taste.
      let artists = await client.getTopArtists('month')
      if (artists.length === 0) artists = await client.getTopArtists('year')
      return artists.map((a) => ({
        name: a.name,
        mbid: a.mbid,
        playCount: a.playCount,
        source: 'listenbrainz',
      }))
    },

    async getSimilarArtists(_artistName, mbid) {
      if (!mbid) return []
      const similar = await client.getSimilarArtists(mbid)
      return similar.map((s) => ({
        name: s.name,
        similarityScore: s.score,
        source: 'listenbrainz',
      }))
    },

    async testConnection() {
      return client.testConnection()
    },

    async getListeningActivity() {
      return client.getListeningActivity()
    },
  }
}
