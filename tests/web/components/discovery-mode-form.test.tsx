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
  it('a single advanced-mode submission carries both a coverage filter and includeUnscored', async () => {
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

    // Set the coverage-type filter while still in Easy mode -- that's where
    // it lives today. No options are attached to this field in this test (no
    // resolveOptions call), so it renders as the free-text comma-separated
    // fallback input.
    fireEvent.change(screen.getByLabelText(/Only these kinds of coverage/), {
      target: { value: 'tymhm' },
    })

    // Switch to Advanced, where includeUnscored lives, and turn it on.
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Include unscored recommendations/ }))

    fireEvent.click(screen.getByRole('button', { name: 'Run discovery' }))

    await waitFor(() => expect(onRun).toHaveBeenCalled())
    const call = onRun.mock.calls[0]?.[0] as { normalizedSettings: Record<string, unknown> }
    expect(call.normalizedSettings.coverageTypes).toEqual(['tymhm'])
    expect(call.normalizedSettings.includeUnscored).toBe(true)
  })
})
