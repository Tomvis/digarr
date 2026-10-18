// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createSubsonicOwnedCheck } from '@/core/subscriptions/owned'
import type { LibraryTrack } from '@/core/types'

const song = (artist: string, name: string): LibraryTrack => ({
  artist,
  name,
  path: `${name}.flac`,
})

describe('createSubsonicOwnedCheck', () => {
  it('searches "<artist> <title>" and matches on normalized artist + title', async () => {
    const searchTracks = vi.fn(async () => [song('Other', 'Hurt'), song('Nine Inch Nails', 'HURT')])
    const isOwned = createSubsonicOwnedCheck({ searchTracks })

    await expect(isOwned('Nine Inch Nails', 'Hurt')).resolves.toBe(true)
    expect(searchTracks).toHaveBeenCalledWith('Nine Inch Nails Hurt', expect.any(Number))
  })

  it('same title by another artist is not owned', async () => {
    const isOwned = createSubsonicOwnedCheck({
      searchTracks: async () => [song('Johnny Cash', 'Hurt')],
    })

    await expect(isOwned('Nine Inch Nails', 'Hurt')).resolves.toBe(false)
  })

  it('propagates a search failure so the caller keeps the track, and retries later', async () => {
    const searchTracks = vi
      .fn<(query: string, limit: number) => Promise<LibraryTrack[]>>()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce([song('A', 'T')])
    const isOwned = createSubsonicOwnedCheck({ searchTracks })

    await expect(isOwned('A', 'T')).rejects.toThrow('down')
    await expect(isOwned('A', 'T')).resolves.toBe(true)
    expect(searchTracks).toHaveBeenCalledTimes(2)
  })

  it('caches per normalized artist + title', async () => {
    const searchTracks = vi.fn(async () => [song('A', 'T')])
    const isOwned = createSubsonicOwnedCheck({ searchTracks })

    await isOwned('A', 'T')
    await expect(isOwned(' a ', 't')).resolves.toBe(true)
    await isOwned('A', 'Other')
    expect(searchTracks).toHaveBeenCalledTimes(2)
  })
})
