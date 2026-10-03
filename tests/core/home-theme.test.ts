// HW-64 (fork): home theme precedence. Must match home-monitoring theme_sync (HW-62).
import { describe, expect, it } from 'vitest'
import {
  type AppThemeChoice,
  effectiveHomeTheme,
  type HomeThemeClaim,
  parseHomeThemeClaim,
  parseHomeThemeState,
  reconcileHomeTheme,
} from '@/core/home-theme'

const follow: HomeThemeClaim = { theme: 'slate', mode: 'automatic', override: 'follow' }
const choice = (basis: string): AppThemeChoice => ({ color: 'home:rave', mode: 'dark', basis })

describe('parseHomeThemeClaim', () => {
  it('accepts the authentik claim shape', () => {
    expect(parseHomeThemeClaim({ theme: 'dusk', mode: 'dark', override: 'dusk/dark' })).toEqual({
      theme: 'dusk',
      mode: 'dark',
      override: 'dusk/dark',
    })
  })
  it('accepts a JSON string', () => {
    expect(parseHomeThemeClaim('{"theme":"ink","mode":"light","override":"follow"}')?.theme).toBe(
      'ink',
    )
  })
  it('treats a missing or odd override as follow', () => {
    expect(parseHomeThemeClaim({ theme: 'ink', mode: 'light' })?.override).toBe('follow')
    expect(parseHomeThemeClaim({ theme: 'ink', mode: 'light', override: 'x' })?.override).toBe(
      'follow',
    )
  })
  it('rejects malformed claims', () => {
    for (const bad of [
      undefined,
      null,
      'nope',
      {},
      { theme: 'slate' },
      { theme: 'slate', mode: 'sepia' },
      { theme: '../x', mode: 'dark' },
      { theme: 3, mode: 'dark' },
    ]) {
      expect(parseHomeThemeClaim(bad)).toBeNull()
    }
  })
})

describe('effectiveHomeTheme', () => {
  it('missing claim and no choice = slate, automatic', () => {
    expect(effectiveHomeTheme({ claim: null, choice: null })).toEqual({
      source: 'claim',
      color: 'home:slate',
      mode: 'system',
    })
  })
  it('follows the claim when there is no in-app choice', () => {
    const claim: HomeThemeClaim = { theme: 'dusk', mode: 'light', override: 'follow' }
    expect(effectiveHomeTheme({ claim, choice: null })).toEqual({
      source: 'claim',
      color: 'home:dusk',
      mode: 'light',
    })
  })
  it('an in-app choice wins while its basis matches the claim override', () => {
    expect(effectiveHomeTheme({ claim: follow, choice: choice('follow') })).toEqual({
      source: 'app',
      color: 'home:rave',
      mode: 'dark',
    })
  })
  it('a global change (override stays follow) keeps the in-app choice', () => {
    const changedGlobal = { ...follow, theme: 'lime', mode: 'dark' as const }
    expect(effectiveHomeTheme({ claim: changedGlobal, choice: choice('follow') }).source).toBe(
      'app',
    )
  })
  it('a new per-app override in authentik replaces the in-app choice', () => {
    const perApp: HomeThemeClaim = { theme: 'ink', mode: 'light', override: 'ink/light' }
    expect(effectiveHomeTheme({ claim: perApp, choice: choice('follow') })).toEqual({
      source: 'claim',
      color: 'home:ink',
      mode: 'light',
    })
  })
  it('switching the per-app choice back to Follow also replaces it', () => {
    expect(effectiveHomeTheme({ claim: follow, choice: choice('ink/light') }).source).toBe('claim')
  })
  it('a choice made without any claim survives a follow claim', () => {
    expect(effectiveHomeTheme({ claim: follow, choice: choice('follow') }).source).toBe('app')
    expect(effectiveHomeTheme({ claim: null, choice: choice('follow') }).source).toBe('app')
  })
})

describe('reconcileHomeTheme', () => {
  it('clears a stale choice and keeps a valid one', () => {
    const perApp: HomeThemeClaim = { theme: 'ink', mode: 'light', override: 'ink/light' }
    expect(reconcileHomeTheme({ claim: perApp, choice: choice('follow') }).choice).toBeNull()
    expect(reconcileHomeTheme({ claim: perApp, choice: choice('ink/light') }).choice).toEqual(
      choice('ink/light'),
    )
  })
})

describe('parseHomeThemeState', () => {
  it('drops invalid stored parts', () => {
    expect(
      parseHomeThemeState({ claim: { theme: 1 }, choice: { color: 'x y', mode: 'dark' } }),
    ).toEqual({ claim: null, choice: null })
    expect(parseHomeThemeState('junk')).toEqual({ claim: null, choice: null })
  })
  it('keeps digarr and home colors', () => {
    for (const color of ['tokyonight', 'home:slate']) {
      expect(
        parseHomeThemeState({ choice: { color, mode: 'light', basis: 'follow' } }).choice?.color,
      ).toBe(color)
    }
  })
})
