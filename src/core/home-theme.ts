/**
 * Per-user home theme (HW-64, Tomvis fork only). Pure logic shared by server and web.
 *
 * authentik's `home_theme` scope adds a claim
 *   home_theme = { theme: "<id>", mode: "automatic|light|dark", override: "follow" | "<theme>/<mode>" }
 * whose theme/mode are already the effective values for digarr. An in-app choice is
 * stored with the `override` seen when it was made (`basis`). It wins only while
 * basis === claim.override; any change of the per-app choice in authentik (including
 * back to Follow) invalidates it. A global change keeps override === "follow", so it
 * never undoes an in-app choice.
 */

export type HomeThemeClaimMode = 'automatic' | 'light' | 'dark'
export type AppThemeMode = 'dark' | 'light' | 'system'

export interface HomeThemeClaim {
  theme: string
  mode: HomeThemeClaimMode
  override: string
}

/** `color` is a digarr theme id ("tokyonight") or a home catalog theme ("home:slate"). */
export interface AppThemeChoice {
  color: string
  mode: AppThemeMode
  basis: string
}

export interface HomeThemeState {
  claim: HomeThemeClaim | null
  choice: AppThemeChoice | null
}

export interface EffectiveTheme {
  source: 'claim' | 'app'
  color: string
  mode: AppThemeMode
}

export const HOME_COLOR_PREFIX = 'home:'
export const DEFAULT_HOME_THEME = 'slate'
const FOLLOW = 'follow'
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/
const OVERRIDE_RE = /^[a-z0-9][a-z0-9_-]{0,39}\/(automatic|light|dark)$/

export function claimModeToAppMode(mode: HomeThemeClaimMode): AppThemeMode {
  return mode === 'automatic' ? 'system' : mode
}

/** Validate an untrusted `home_theme` claim. Returns null when absent or malformed. */
export function parseHomeThemeClaim(raw: unknown): HomeThemeClaim | null {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object') return null
  const { theme, mode, override } = value as Record<string, unknown>
  if (typeof theme !== 'string' || !ID_RE.test(theme)) return null
  if (mode !== 'automatic' && mode !== 'light' && mode !== 'dark') return null
  const ov = typeof override === 'string' && OVERRIDE_RE.test(override) ? override : FOLLOW
  return { theme, mode, override: ov }
}

export function isValidChoiceColor(color: unknown): color is string {
  if (typeof color !== 'string') return false
  const id = color.startsWith(HOME_COLOR_PREFIX) ? color.slice(HOME_COLOR_PREFIX.length) : color
  return ID_RE.test(id)
}

export function isAppThemeMode(mode: unknown): mode is AppThemeMode {
  return mode === 'dark' || mode === 'light' || mode === 'system'
}

/** The override value a choice made now would be based on (missing claim = follow). */
export function currentBasis(claim: HomeThemeClaim | null): string {
  return claim?.override ?? FOLLOW
}

/** Drop an in-app choice made under a different per-app override than the claim's. */
export function reconcileHomeTheme(state: HomeThemeState): HomeThemeState {
  if (state.choice && state.choice.basis !== currentBasis(state.claim)) {
    return { claim: state.claim, choice: null }
  }
  return state
}

export function effectiveHomeTheme(state: HomeThemeState): EffectiveTheme {
  const { claim, choice } = reconcileHomeTheme(state)
  if (choice) return { source: 'app', color: choice.color, mode: choice.mode }
  return {
    source: 'claim',
    color: `${HOME_COLOR_PREFIX}${claim?.theme ?? DEFAULT_HOME_THEME}`,
    mode: claimModeToAppMode(claim?.mode ?? 'automatic'),
  }
}

/** Parse a stored state blob defensively (it lives in users.preferences JSON). */
export function parseHomeThemeState(raw: unknown): HomeThemeState {
  if (!raw || typeof raw !== 'object') return { claim: null, choice: null }
  const { claim, choice } = raw as Record<string, unknown>
  let parsedChoice: AppThemeChoice | null = null
  if (choice && typeof choice === 'object') {
    const c = choice as Record<string, unknown>
    if (isValidChoiceColor(c.color) && isAppThemeMode(c.mode) && typeof c.basis === 'string') {
      parsedChoice = { color: c.color, mode: c.mode, basis: c.basis }
    }
  }
  return { claim: parseHomeThemeClaim(claim), choice: parsedChoice }
}
