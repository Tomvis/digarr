// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/web/lib/i18n'

vi.mock('@/web/lib/locale-storage', () => ({
  detectBrowserLocale: vi.fn(() => 'en'),
  getStoredLocale: vi.fn(() => 'en'),
  setStoredLocale: vi.fn(),
}))

vi.mock('@/web/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/web/lib/api')>()
  return {
    ...actual,
    listApiKeys: vi.fn(),
    createApiKey: vi.fn(),
    revokeApiKey: vi.fn(),
  }
})

import { ApiKeysCard } from '@/web/components/api-keys-card'
import { createApiKey, listApiKeys } from '@/web/lib/api'

function renderCard(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <I18nProvider>{ui}</I18nProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

const KEY = {
  id: 1,
  userId: 1,
  name: 'Music Assistant',
  prefix: 'ab12cd34',
  scopes: ['read', 'write'],
  createdAt: new Date().toISOString(),
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
}

beforeEach(() => {
  vi.mocked(listApiKeys).mockResolvedValue({ items: [KEY] } as never)
})

describe('ApiKeysCard', () => {
  it('lists existing keys with their prefix', async () => {
    renderCard(<ApiKeysCard />)
    expect(await screen.findByText('Music Assistant')).toBeInTheDocument()
    expect(screen.getByText(/ab12cd34/)).toBeInTheDocument()
  })

  it('shows an empty state when the user has no keys', async () => {
    vi.mocked(listApiKeys).mockResolvedValue({ items: [] } as never)
    renderCard(<ApiKeysCard />)
    expect(await screen.findByText(/no api keys/i)).toBeInTheDocument()
  })

  it('reveals the created token once, with a warning that it will not reappear', async () => {
    const token = 'dgr_ab12cd34_secretsecretsecret'
    vi.mocked(createApiKey).mockResolvedValue({ key: { ...KEY, id: 2 }, token } as never)
    renderCard(<ApiKeysCard />)

    await userEvent.click(await screen.findByRole('button', { name: /create/i }))
    await userEvent.type(screen.getByLabelText(/name/i), 'new key')
    await userEvent.click(screen.getByRole('button', { name: /^create$/i }))

    await waitFor(() => expect(screen.getByText(token)).toBeInTheDocument())
    expect(screen.getByText(/not be shown again|won't be shown again/i)).toBeInTheDocument()
  })

  it('cannot create a second key while an uncopied token is still revealed', async () => {
    // The secret is unrecoverable, so a second create that overwrote the panel
    // would destroy it with no warning.
    const token = 'dgr_ab12cd34_secretsecretsecret'
    vi.mocked(createApiKey).mockResolvedValue({ key: { ...KEY, id: 2 }, token } as never)
    renderCard(<ApiKeysCard />)

    await userEvent.click(await screen.findByRole('button', { name: /create api key/i }))
    await userEvent.type(screen.getByLabelText(/name/i), 'new key')
    await userEvent.click(screen.getByRole('button', { name: /^create$/i }))
    await waitFor(() => expect(screen.getByText(token)).toBeInTheDocument())

    const createButton = screen.getByRole('button', { name: /create api key/i })
    expect(createButton).toBeDisabled()

    // Dismissing the reveal panel releases the block.
    await userEvent.click(screen.getByRole('button', { name: /done/i }))
    await waitFor(() => expect(screen.queryByText(token)).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: /create api key/i })).toBeEnabled()
  })

  it('never renders a revoked key as usable', async () => {
    vi.mocked(listApiKeys).mockResolvedValue({
      items: [{ ...KEY, revokedAt: new Date().toISOString() }],
    } as never)
    renderCard(<ApiKeysCard />)
    expect(await screen.findByText(/revoked/i)).toBeInTheDocument()
  })
})
