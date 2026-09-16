import { describe, expect, it } from 'vitest'
import { normalizeAlbumTitle, normalizeArtistName } from '@/core/matching/normalize'

describe('normalizeArtistName', () => {
  it('lowercases and trims', () => {
    expect(normalizeArtistName('  Boards of Canada ')).toBe('boards of canada')
  })

  it('strips diacritics so cross-source spellings match', () => {
    expect(normalizeArtistName('Sigur Rós')).toBe(normalizeArtistName('Sigur Ros'))
    expect(normalizeArtistName('Mötley Crüe')).toBe('motley crue')
  })

  it('collapses internal whitespace', () => {
    expect(normalizeArtistName('Godspeed  You!  Black   Emperor')).toBe(
      'godspeed you! black emperor',
    )
  })
})

describe('normalizeAlbumTitle', () => {
  it('lowercases, trims and strips diacritics', () => {
    expect(normalizeAlbumTitle('  Ágætis Byrjun ')).toBe('agaetis byrjun')
  })

  it('is stable across repeated application', () => {
    const once = normalizeAlbumTitle('Kid A')
    expect(normalizeAlbumTitle(once)).toBe(once)
  })
})
