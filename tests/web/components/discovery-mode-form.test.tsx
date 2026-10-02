// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createCriticallyAcclaimedMode } from '@/core/discovery-modes/modes/critically-acclaimed'
import type { DiscoveryConfigField } from '@/core/discovery-modes/types'
import { DiscoveryModeForm } from '@/web/components/discovery-mode-form'
import type { DiscoveryModeResponse } from '@/web/lib/api'
import { I18nProvider } from '@/web/lib/i18n'

vi.mock('@/web/lib/locale-storage', () => ({
  detectBrowserLocale: vi.fn(() => 'en'),
  getRequestLocale: vi.fn(() => 'en'),
  getStoredLocale: vi.fn(() => 'en'),
  setStoredLocale: vi.fn(),
}))

function renderForm({ fields }: { fields: DiscoveryConfigField[] }) {
  const mode: DiscoveryModeResponse = {
    id: 'test-mode',
    label: 'Test Mode',
    description: 'A test discovery mode',
    availability: { enabled: true, fallbackUsed: false, providerPath: [] },
    easyFields: fields,
    advancedFields: [],
  }

  return render(
    <I18nProvider>
      <DiscoveryModeForm mode={mode} onRun={vi.fn().mockResolvedValue(undefined)} />
    </I18nProvider>,
  )
}

describe('multiselect rendering', () => {
  it('renders a picker when the field supplies options', () => {
    renderForm({
      fields: [
        {
          // Deliberately not a real registered field key: this test is
          // pinning generic multiselect-with-options rendering, not any
          // one mode's field, so it must not collide with a real
          // `discoveryMode.field.*` catalog key (e.g. `coverageTypes`,
          // since `critically-acclaimed` now owns that key with its own
          // translated label) -- a collision would make the form render
          // the catalog's translation instead of this fixture's literal
          // `label` below.
          key: 'demoMultiselect',
          label: 'Coverage',
          type: 'multiselect',
          options: [
            { value: 'tymhm', label: 'Things You Might Have Missed' },
            { value: 'aoty', label: 'Album of the Year' },
          ],
        },
      ],
    })
    expect(screen.getByRole('checkbox', { name: /Things You Might Have Missed/ })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: /Album of the Year/ })).toBeTruthy()
    expect(screen.getByRole('group', { name: /Coverage/ })).toBeTruthy()
  })

  it('keeps the free-text input when the field supplies no options', () => {
    renderForm({
      fields: [{ key: 'seedArtists', label: 'Seed artists', type: 'multiselect', required: true }],
    })
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByLabelText(/Seed artists/)).toHaveProperty('tagName', 'INPUT')
  })
})

/**
 * FIX 1 (final fix wave, CRITICAL): `includeGenres`/`excludeGenres`/
 * `coverageTypes` used to live only in `easyFields` while `includeUnscored`
 * lived only in `advancedFields` -- `buildSubmission` (discovery-mode-form.tsx)
 * emits only the CURRENT settings-mode's fields, so the two halves could
 * never reach a single submission together. Ticking a coverage filter in Easy
 * mode and running silently returned zero results (the score gate excludes
 * NULL-ratio rows when `includeUnscored` resolves to its false default);
 * switching to Advanced to find the toggle dropped the coverage filter
 * entirely instead. Fixed by making `advancedFields` a superset of
 * `easyFields`. This exercises the REAL mode's field declarations (not a
 * fixture) end to end through the actual form, so it fails again if the two
 * field sets ever go disjoint.
 */
describe('critically-acclaimed advanced-mode field coverage (FIX 1)', () => {
  it('a single advanced-mode submission carries per-site coverage, unscored and score settings (MUSIC-26)', async () => {
    const acclaimedMode = createCriticallyAcclaimedMode()
    const mode: DiscoveryModeResponse = {
      id: acclaimedMode.id,
      label: acclaimedMode.label,
      description: acclaimedMode.description,
      availability: { enabled: true, fallbackUsed: true, providerPath: [] },
      easyFields: acclaimedMode.easyFields,
      advancedFields: acclaimedMode.advancedFields,
    }
    const onRun = vi.fn().mockResolvedValue(undefined)

    render(
      <I18nProvider>
        <DiscoveryModeForm mode={mode} onRun={onRun} />
      </I18nProvider>,
    )

    // Set AMG's coverage filter in Easy mode (no options attached here, so it
    // renders as the free-text fallback). AMG's section comes first.
    const coverageInputs = screen.getAllByLabelText(/Only these kinds of coverage/)
    fireEvent.change(coverageInputs[0] as HTMLElement, { target: { value: 'tymhm' } })

    // Switch to Advanced; per-site settings carry over, then change two more.
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    const unscored = screen.getAllByRole('checkbox', { name: /Include unscored picks/ })
    fireEvent.click(unscored[0] as HTMLElement)
    const minScores = screen.getAllByLabelText(/^Minimum score$/)
    fireEvent.change(minScores[0] as HTMLElement, { target: { value: '3.5' } })

    fireEvent.click(screen.getByRole('button', { name: 'Run discovery' }))

    await waitFor(() => expect(onRun).toHaveBeenCalled())
    const call = onRun.mock.calls[0]?.[0] as { normalizedSettings: Record<string, unknown> }
    expect(call.normalizedSettings.amgCoverageTypes).toEqual(['tymhm'])
    expect(call.normalizedSettings.amgIncludeUnscored).toBe(false)
    expect(call.normalizedSettings.amgMinScore).toBe(3.5)
    // Untouched sites keep their defaults: on, native default bar.
    expect(call.normalizedSettings.tpsEnabled).toBe(true)
    expect(call.normalizedSettings.tpsMinScore).toBe(8)
  })

  /**
   * The test above proves the invariant end to end, but only for
   * `coverageTypes` -- it is the key a user is most likely to combine with
   * `includeUnscored`, not the only one at risk. Moving any OTHER easy key
   * back out of `advancedFields` (say `excludeGenres`) would silently
   * discard that filter for every Advanced-mode run while the end-to-end
   * test stayed green. This states the invariant itself, so the guard does
   * not depend on which key someone happens to break.
   */
  it('declares advancedFields as a superset of easyFields', () => {
    const { easyFields, advancedFields } = createCriticallyAcclaimedMode()
    expect(advancedFields.map((f) => f.key)).toEqual(
      expect.arrayContaining(easyFields.map((f) => f.key)),
    )
  })
})
