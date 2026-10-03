// Pre-paint theme (HW-64, Tomvis fork). External file because the CSP (script-src 'self')
// blocks inline scripts. Mirrors applyTheme() in src/web/lib/theme.ts from its localStorage cache.
;(() => {
  const root = document.documentElement
  try {
    const m = localStorage.getItem('digarr-theme') || 'system'
    const c = localStorage.getItem('digarr-color-theme') || 'home:slate'
    const light = matchMedia('(prefers-color-scheme: light)').matches
    const resolved = m === 'system' ? (light ? 'light' : 'dark') : m
    if (c !== 'home' && !c.startsWith('home:')) {
      root.setAttribute('data-theme', `${c}-${resolved}`)
      return
    }
    root.setAttribute('data-theme', `home-${resolved}`)
    const vars = JSON.parse(localStorage.getItem('digarr-home-vars') || 'null')
    for (const [k, v] of Object.entries(vars?.[resolved] ?? {})) {
      if (v) root.style.setProperty(k, v)
    }
  } catch {
    root.setAttribute('data-theme', 'home-dark')
  }
})()
