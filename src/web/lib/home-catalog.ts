// Home theme catalog (HW-64, Tomvis fork only). Source of truth is homelab-stacks
// theme/dist/themes/all.json, served at theme.leratom.cloud. home-themes.json is a vendored
// copy for first paint/offline; the live catalog is fetched at runtime and cached, so new
// home themes show up without a rebuild.
import vendored from './home-themes.json'

export type HomeRoles = Record<string, string>
export interface HomeCatalogTheme {
  id: string
  name: string
  description?: string
  designed_as?: 'light' | 'dark'
  modes: { light: HomeRoles; dark: HomeRoles }
}
export interface HomeCatalog {
  default: string
  themes: HomeCatalogTheme[]
}

export const HOME_CATALOG_URL = 'https://theme.leratom.cloud/dist/themes/all.json'
const CACHE_KEY = 'digarr-home-catalog'
const REQUIRED_ROLES = ['bg', 'surface', 'border', 'text', 'primary', 'on-primary'] as const

function isCatalog(value: unknown): value is HomeCatalog {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<HomeCatalog>
  if (typeof v.default !== 'string' || !Array.isArray(v.themes) || v.themes.length === 0) {
    return false
  }
  return v.themes.every(
    (t) =>
      t &&
      typeof t.id === 'string' &&
      typeof t.name === 'string' &&
      (['light', 'dark'] as const).every((m) =>
        REQUIRED_ROLES.every((r) => typeof t.modes?.[m]?.[r] === 'string'),
      ),
  )
}

function readCached(): HomeCatalog | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null')
    return isCatalog(parsed) ? parsed : null
  } catch {
    return null
  }
}

let catalog: HomeCatalog = readCached() ?? (vendored as HomeCatalog)

export function getHomeCatalog(): HomeCatalog {
  return catalog
}

/** Fetch the live catalog; returns it when it replaced the current one. */
export async function refreshHomeCatalog(
  fetchImpl: typeof fetch = fetch,
): Promise<HomeCatalog | null> {
  try {
    const res = await fetchImpl(HOME_CATALOG_URL, { cache: 'no-cache' })
    if (!res.ok) return null
    const next: unknown = await res.json()
    if (!isCatalog(next)) return null
    const changed = JSON.stringify(next) !== JSON.stringify(catalog)
    catalog = next
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(next))
    } catch {
      // storage full or blocked: the in-memory copy still applies
    }
    return changed ? next : null
  } catch {
    return null
  }
}

export function findHomeTheme(id: string | undefined): HomeCatalogTheme | undefined {
  return catalog.themes.find((t) => t.id === id)
}

/** The theme for `id`, else the catalog default (unknown ids fall back, never break). */
export function resolveHomeTheme(id: string | undefined): HomeCatalogTheme {
  return (
    findHomeTheme(id) ?? findHomeTheme(catalog.default) ?? (catalog.themes[0] as HomeCatalogTheme)
  )
}

/** Home roles -> digarr's color tokens. */
export function homeVars(roles: HomeRoles): Record<string, string> {
  const pick = (...keys: string[]) => keys.map((k) => roles[k]).find(Boolean) ?? ''
  return {
    '--color-bg': pick('bg'),
    '--color-surface': pick('surface'),
    '--color-border': pick('border'),
    '--color-accent': pick('primary'),
    '--color-accent-fg': pick('on-primary'),
    '--color-approve': pick('success', 'primary'),
    '--color-reject': pick('alarm', 'primary'),
    '--color-info': pick('link', 'primary'),
    '--color-warning': pick('warning', 'primary'),
    '--color-text': pick('text'),
    '--color-muted': pick('text-disabled', 'text-2', 'text'),
  }
}
