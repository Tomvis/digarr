import type { createSubsonicClient } from '@/core/clients/subsonic'
import type { LibraryAlbum, LibraryArtist, LibrarySource } from './types'

type SubsonicClient = ReturnType<typeof createSubsonicClient>

/**
 * Wraps the existing Subsonic client as a LibrarySource. Plain Subsonic ID3
 * artists carry no MBIDs; OpenSubsonic servers (Navidrome) send the artist's
 * `musicBrainzId`, which is passed through so the reconciler can skip its
 * MusicBrainz name search for that artist. Still 'low' quality overall: the
 * field is optional and only as good as the server's tags.
 *
 * Subsonic is per-user (each Digarr user can configure their own
 * Subsonic/Navidrome server).
 */
export function createSubsonicLibrarySource(client: SubsonicClient, userId: number): LibrarySource {
  return {
    id: 'subsonic',
    name: 'Subsonic',
    capabilities: ['listArtists', 'listAlbums'],
    userId,
    mbidQuality: 'low', // MBIDs only when the server is OpenSubsonic; reconciler name-matches the rest

    async listArtists(): Promise<LibraryArtist[]> {
      const artists = await client.getAllArtists()
      return artists.map((a) => ({
        sourceArtistId: a.id,
        name: a.name,
        mbid: a.mbid,
      }))
    },

    async listAlbums(sourceArtistId): Promise<LibraryAlbum[]> {
      const albums = await client.getAlbumsForArtist(sourceArtistId)
      return albums.map((al) => ({
        sourceAlbumId: al.id,
        sourceArtistId: al.artistId,
        title: al.title,
        mbid: undefined,
        releaseYear: al.releaseYear,
        primaryType: 'Album' as const,
      }))
    },

    testConnection() {
      return client.testConnection()
    },
  }
}
