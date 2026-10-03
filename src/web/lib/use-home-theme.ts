// Per-user theme state for the app shell (HW-64, Tomvis fork only). The server holds the
// authentik claim and the in-app choice (src/core/home-theme.ts); localStorage only caches the
// effective theme for first paint.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
import { refreshHomeCatalog, resolveHomeTheme } from './home-catalog'
import { getHomeTheme, type HomeThemeResponse, updateHomeTheme } from './home-theme-api'
import {
  applyTheme,
  type ColorTheme,
  getStoredColorTheme,
  getStoredMode,
  type Mode,
  normalizeColorTheme,
  setStoredColorTheme,
  setStoredMode,
} from './theme'

export const HOME_THEME_QUERY_KEY = ['homeTheme'] as const

export function useHomeTheme() {
  const queryClient = useQueryClient()
  const [mode, setModeState] = useState<Mode>(getStoredMode)
  const [colorTheme, setColorState] = useState<ColorTheme>(getStoredColorTheme)
  const [catalogVersion, setCatalogVersion] = useState(0)
  const { data } = useQuery({
    queryKey: HOME_THEME_QUERY_KEY,
    queryFn: getHomeTheme,
    retry: false,
    staleTime: 60_000,
  })

  const commit = useCallback((color: ColorTheme, m: Mode) => {
    setColorState(color)
    setModeState(m)
    try {
      setStoredColorTheme(color)
      setStoredMode(m)
    } catch {
      // storage blocked: the server copy still drives the theme
    }
    applyTheme(color, m)
  }, [])

  // Server state wins whenever it (re)loads.
  useEffect(() => {
    if (data) commit(normalizeColorTheme(data.effective.color), data.effective.mode)
  }, [data, commit])

  // Live catalog: new home themes appear without a rebuild.
  useEffect(() => {
    void refreshHomeCatalog().then((changed) => {
      if (changed) setCatalogVersion((n) => n + 1)
    })
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-apply only when the catalog changes
  useEffect(() => {
    if (catalogVersion > 0) commit(normalizeColorTheme(colorTheme), mode)
  }, [catalogVersion])

  // "System" follows the device live.
  useEffect(() => {
    if (mode !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const handler = () => applyTheme(colorTheme, 'system')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [mode, colorTheme])

  const mutation = useMutation({
    mutationFn: updateHomeTheme,
    onSuccess: (res: HomeThemeResponse) => queryClient.setQueryData(HOME_THEME_QUERY_KEY, res),
  })

  const setMode = (m: Mode) => {
    commit(colorTheme, m)
    mutation.mutate({ color: colorTheme, mode: m })
  }
  const setColorTheme = (t: ColorTheme) => {
    commit(t, mode)
    mutation.mutate({ color: t, mode })
  }
  const followHome = () => mutation.mutate({ follow: true })

  return {
    mode,
    colorTheme,
    setMode,
    setColorTheme,
    followHome,
    /** null until the server answered (e.g. offline): the picker then hides Follow state. */
    following: data ? data.effective.source === 'claim' : null,
    homeThemeName: resolveHomeTheme(data?.claim?.theme).name,
    catalogVersion,
  }
}
