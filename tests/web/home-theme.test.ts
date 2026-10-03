// @vitest-environment jsdom
// HW-64 (fork): home catalog themes in digarr's theme layer.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getHomeCatalog, refreshHomeCatalog } from '@/web/lib/home-catalog'
import vendored from '@/web/lib/home-themes.json'
import { applyTheme, homeColorThemes, normalizeColorTheme } from '@/web/lib/theme'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('style')
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia
})

describe('home catalog in the picker', () => {
  it('offers every vendored home theme', () => {
    expect(homeColorThemes().map((t) => t.id)).toEqual(
      vendored.themes.map((t: { id: string }) => `home:${t.id}`),
    )
  })

  it('normalizes legacy, unknown and digarr ids', () => {
    expect(normalizeColorTheme('home')).toBe('home:slate')
    expect(normalizeColorTheme(null)).toBe('home:slate')
    expect(normalizeColorTheme('home:nope')).toBe('home:slate')
    expect(normalizeColorTheme('home:dusk')).toBe('home:dusk')
    expect(normalizeColorTheme('tokyonight')).toBe('tokyonight')
    expect(normalizeColorTheme('bogus')).toBe('home:slate')
  })
})

describe('applyTheme', () => {
  it('sets a home theme as runtime vars on data-theme=home-<mode>', () => {
    applyTheme('home:dusk', 'light')
    const root = document.documentElement
    const dusk = vendored.themes.find((t: { id: string }) => t.id === 'dusk')
    expect(root.getAttribute('data-theme')).toBe('home-light')
    expect(root.getAttribute('data-home-theme')).toBe('dusk')
    expect(root.style.getPropertyValue('--color-bg')).toBe(dusk?.modes.light.bg)
    expect(root.style.getPropertyValue('--color-accent')).toBe(dusk?.modes.light.primary)
    expect(JSON.parse(localStorage.getItem('digarr-home-vars') ?? '{}').dark['--color-bg']).toBe(
      dusk?.modes.dark.bg,
    )
  })

  it('switching to a digarr theme removes the home vars', () => {
    applyTheme('home:dusk', 'dark')
    applyTheme('nord', 'dark')
    const root = document.documentElement
    expect(root.getAttribute('data-theme')).toBe('nord-dark')
    expect(root.getAttribute('data-home-theme')).toBeNull()
    expect(root.style.getPropertyValue('--color-bg')).toBe('')
  })
})

describe('refreshHomeCatalog', () => {
  it('adopts a valid live catalog with new themes and caches it', async () => {
    const extra = { ...vendored.themes[0], id: 'brandnew', name: 'Brand new' }
    const live = { ...vendored, themes: [...vendored.themes, extra] }
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(live)))
    expect(await refreshHomeCatalog(fetchImpl as unknown as typeof fetch)).not.toBeNull()
    expect(getHomeCatalog().themes.at(-1)?.id).toBe('brandnew')
    expect(homeColorThemes().some((t) => t.id === 'home:brandnew')).toBe(true)
    expect(localStorage.getItem('digarr-home-catalog')).toContain('brandnew')
  })

  it('ignores an invalid live catalog', async () => {
    const before = getHomeCatalog()
    const fetchImpl = vi.fn(async () => new Response('{"themes":[]}'))
    expect(await refreshHomeCatalog(fetchImpl as unknown as typeof fetch)).toBeNull()
    expect(getHomeCatalog()).toBe(before)
  })
})
