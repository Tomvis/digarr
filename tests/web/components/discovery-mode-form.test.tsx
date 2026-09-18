// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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
