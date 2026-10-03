// HW-64 (fork): per-user home theme API. Kept out of api.ts so upstream's api mocks stay valid.
import type { AppThemeChoice, EffectiveTheme, HomeThemeClaim } from '@/core/home-theme'

export type HomeThemeResponse = {
  claim: HomeThemeClaim | null
  choice: AppThemeChoice | null
  effective: EffectiveTheme
}

async function call(init?: RequestInit): Promise<HomeThemeResponse> {
  const res = await fetch('/api/v1/auth/me/theme', {
    credentials: 'same-origin',
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', 'X-Digarr-CSRF': '1' } : {},
  })
  if (!res.ok) throw new Error(`home theme: HTTP ${res.status}`)
  const body = (await res.json()) as Partial<HomeThemeResponse> | null
  if (typeof body?.effective?.color !== 'string') throw new Error('home theme: bad response')
  return body as HomeThemeResponse
}

export const getHomeTheme = () => call()
export const updateHomeTheme = (body: { follow: true } | { color: string; mode: string }) =>
  call({ method: 'PUT', body: JSON.stringify(body) })
