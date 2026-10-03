import { HOME_COLOR_PREFIX } from '@/core/home-theme'
import { getHomeCatalog, homeVars, resolveHomeTheme } from './home-catalog'

export type Mode = 'dark' | 'light' | 'system'

// HW-64 (fork): home catalog themes are `home:<id>` (all of theme.leratom.cloud's catalog).
export type HomeColorTheme = `home:${string}`

export type DigarrColorTheme =
  | 'digarr'
  | 'tokyonight'
  | 'catppuccin'
  | 'dracula'
  | 'nord'
  | 'gruvbox'
  | 'solarized'
  | 'rosepine'
  | 'onedark'
  | 'spotarr'
  | 'youtarr'
  | 'deezarr'
  | 'amazarr'
  | 'qobuzarr'
  | 'applarr'
  | 'tidarr'

export type ColorTheme = DigarrColorTheme | HomeColorTheme

export const COLOR_THEMES: { id: DigarrColorTheme; name: string; group?: string }[] = [
  // Project signature
  { id: 'digarr', name: 'Digarr', group: 'Project' },
  // Editor themes
  { id: 'tokyonight', name: 'Tokyo Night', group: 'Editor' },
  { id: 'catppuccin', name: 'Catppuccin', group: 'Editor' },
  { id: 'dracula', name: 'Dracula', group: 'Editor' },
  { id: 'nord', name: 'Nord', group: 'Editor' },
  { id: 'gruvbox', name: 'Gruvbox', group: 'Editor' },
  { id: 'solarized', name: 'Solarized', group: 'Editor' },
  { id: 'rosepine', name: 'Rose Pine', group: 'Editor' },
  { id: 'onedark', name: 'One Dark', group: 'Editor' },
  // *arr streaming themes
  { id: 'spotarr', name: 'Spotarr', group: 'Streaming' },
  { id: 'youtarr', name: 'Youtarr', group: 'Streaming' },
  { id: 'deezarr', name: 'Deezarr', group: 'Streaming' },
  { id: 'amazarr', name: 'Amazarr', group: 'Streaming' },
  { id: 'qobuzarr', name: 'Qobuzarr', group: 'Streaming' },
  { id: 'applarr', name: 'Applarr', group: 'Streaming' },
  { id: 'tidarr', name: 'Tidarr', group: 'Streaming' },
]

const MODE_KEY = 'digarr-theme'
const COLOR_KEY = 'digarr-color-theme'

// Keep backward compat: old 'dark'/'light' values still work as Mode
export function getStoredMode(): Mode {
  const stored = localStorage.getItem(MODE_KEY)
  if (stored === 'dark' || stored === 'light' || stored === 'system') return stored
  return 'system'
}

export function setStoredMode(mode: Mode): void {
  localStorage.setItem(MODE_KEY, mode)
}

export function isHomeColor(theme: string): theme is HomeColorTheme {
  return theme.startsWith(HOME_COLOR_PREFIX)
}

/** Every home catalog theme as a picker entry. */
export function homeColorThemes(): { id: HomeColorTheme; name: string; swatch: HomeSwatch }[] {
  return getHomeCatalog().themes.map((t) => ({
    id: `home:${t.id}` as HomeColorTheme,
    name: t.name,
    swatch: { light: t.modes.light.primary ?? '', dark: t.modes.dark.primary ?? '' },
  }))
}
export type HomeSwatch = { light: string; dark: string }

/** Map any stored/claimed color to one that exists (unknown home ids -> catalog default). */
export function normalizeColorTheme(value: string | null | undefined): ColorTheme {
  if (!value || value === 'home') return `home:${resolveHomeTheme(undefined).id}`
  if (isHomeColor(value))
    return `home:${resolveHomeTheme(value.slice(HOME_COLOR_PREFIX.length)).id}`
  if (COLOR_THEMES.some((t) => t.id === value)) return value as DigarrColorTheme
  return `home:${resolveHomeTheme(undefined).id}`
}

export function getStoredColorTheme(): ColorTheme {
  try {
    return normalizeColorTheme(localStorage.getItem(COLOR_KEY))
  } catch {
    return normalizeColorTheme(null)
  }
}

export function setStoredColorTheme(theme: ColorTheme): void {
  localStorage.setItem(COLOR_KEY, theme)
}

export function resolveMode(mode: Mode): 'dark' | 'light' {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }
  return mode
}

// Pre-paint cache for public/theme-boot.js: the selected home theme's vars for both modes.
const HOME_VARS_KEY = 'digarr-home-vars'
const VAR_NAMES = Object.keys(homeVars({}))

export function applyTheme(colorTheme: ColorTheme, mode: Mode): void {
  const resolved = resolveMode(mode)
  const root = document.documentElement
  if (isHomeColor(colorTheme)) {
    const theme = resolveHomeTheme(colorTheme.slice(HOME_COLOR_PREFIX.length))
    const vars = homeVars(theme.modes[resolved])
    for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value)
    root.setAttribute('data-theme', `home-${resolved}`)
    root.setAttribute('data-home-theme', theme.id)
    setThemeColorMeta(vars['--color-bg'])
    try {
      localStorage.setItem(
        HOME_VARS_KEY,
        JSON.stringify({ light: homeVars(theme.modes.light), dark: homeVars(theme.modes.dark) }),
      )
    } catch {
      // first paint falls back to the slate CSS in home-theme.css
    }
    return
  }
  for (const name of VAR_NAMES) root.style.removeProperty(name)
  root.removeAttribute('data-home-theme')
  root.setAttribute('data-theme', `${colorTheme}-${resolved}`)
  setThemeColorMeta(getComputedStyle(root).getPropertyValue('--color-bg').trim())
}

function setThemeColorMeta(color: string | undefined): void {
  if (!color) return
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color)
}
