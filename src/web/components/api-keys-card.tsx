import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, KeyRound } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'
import { API_KEY_SCOPES, type ApiKeyScope } from '@/core/auth/api-keys'
import type { MessageKey } from '@/core/i18n/messages/types'
import { type ApiKey, createApiKey, listApiKeys, revokeApiKey } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { ConfirmDialog } from './confirm-dialog'
import { Field } from './field'
import { ServiceCard } from './service-card'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Input } from './ui/input'

const SCOPE_LABEL: Record<ApiKeyScope, MessageKey> = {
  read: 'apiKeys.scopeRead',
  write: 'apiKeys.scopeWrite',
  admin: 'apiKeys.scopeAdmin',
}

const KNOWN_SCOPES = new Set<string>(API_KEY_SCOPES)

function isKnownScope(scope: string): scope is ApiKeyScope {
  return KNOWN_SCOPES.has(scope)
}

type CreatedToken = {
  token: string
}

export function ApiKeysCard() {
  const { t, locale } = useI18n()
  const queryClient = useQueryClient()
  const { data, isLoading, error } = useQuery({ queryKey: ['api-keys'], queryFn: listApiKeys })

  const [showCreateForm, setShowCreateForm] = useState(false)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<ApiKeyScope[]>(['read'])
  const [creating, setCreating] = useState(false)
  const [revokingId, setRevokingId] = useState<number | null>(null)
  const [confirmRevoke, setConfirmRevoke] = useState<{ id: number; name: string } | null>(null)
  const [createdToken, setCreatedToken] = useState<CreatedToken | null>(null)
  const [copied, setCopied] = useState(false)

  const items: ApiKey[] = data?.items ?? []

  function toggleScope(scope: ApiKeyScope) {
    setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]))
  }

  function resetForm() {
    setName('')
    setScopes(['read'])
    setShowCreateForm(false)
  }

  async function handleCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName || scopes.length === 0) return
    setCreating(true)
    try {
      const result = await createApiKey({ name: trimmedName, scopes })
      await queryClient.invalidateQueries({ queryKey: ['api-keys'] })
      setCreatedToken({ token: result.token })
      toast.success(t('apiKeys.createSuccess'))
      resetForm()
    } catch {
      toast.error(t('apiKeys.createFailed'))
    } finally {
      setCreating(false)
    }
  }

  async function handleRevoke(id: number) {
    setRevokingId(id)
    try {
      await revokeApiKey(id)
      await queryClient.invalidateQueries({ queryKey: ['api-keys'] })
      toast.success(t('apiKeys.revokeSuccess'))
    } catch {
      toast.error(t('apiKeys.revokeFailed'))
    } finally {
      setRevokingId(null)
    }
  }

  async function handleCopyToken() {
    if (!createdToken) return
    try {
      await navigator.clipboard.writeText(createdToken.token)
      setCopied(true)
      toast.success(t('apiKeys.tokenCopied'))
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error(t('common.unknownError'))
    }
  }

  function formatLastUsed(value: string | null): string {
    if (!value) return t('apiKeys.neverUsed')
    return new Date(value).toLocaleDateString(locale)
  }

  const hasActiveKey = items.some((key) => !key.revokedAt)

  return (
    <ServiceCard
      name={t('apiKeys.title')}
      description={t('apiKeys.description')}
      status={hasActiveKey ? 'connected' : 'not_configured'}
      icon={
        <span className="flex items-center justify-center w-6 h-6 text-muted">
          <KeyRound size={18} />
        </span>
      }
    >
      {isLoading && <p className="text-sm text-muted">{t('common.loading')}</p>}
      {error && <p className="text-sm text-reject">{t('apiKeys.loadFailed')}</p>}

      {!isLoading &&
        !error &&
        (items.length === 0 ? (
          <p className="text-sm text-muted">{t('apiKeys.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 pr-3 text-muted font-medium">
                    {t('apiKeys.columnName')}
                  </th>
                  <th className="text-left py-2 px-3 text-muted font-medium">
                    {t('apiKeys.columnPrefix')}
                  </th>
                  <th className="text-left py-2 px-3 text-muted font-medium">
                    {t('apiKeys.columnScopes')}
                  </th>
                  <th className="text-left py-2 px-3 text-muted font-medium">
                    {t('apiKeys.columnCreated')}
                  </th>
                  <th className="text-left py-2 px-3 text-muted font-medium">
                    {t('apiKeys.columnLastUsed')}
                  </th>
                  <th className="text-right py-2 pl-3 text-muted font-medium">
                    <span className="sr-only">{t('apiKeys.revoke')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((key) => (
                  <tr key={key.id} className="border-b border-border/50">
                    <td className="py-2 pr-3 font-medium text-text">{key.name}</td>
                    <td className="py-2 px-3 text-muted font-mono text-xs">{key.prefix}</td>
                    <td className="py-2 px-3 text-muted">
                      {key.scopes
                        .filter(isKnownScope)
                        .map((scope) => t(SCOPE_LABEL[scope]))
                        .join(', ')}
                    </td>
                    <td className="py-2 px-3 text-muted">
                      {new Date(key.createdAt).toLocaleDateString(locale)}
                    </td>
                    <td className="py-2 px-3 text-muted">{formatLastUsed(key.lastUsedAt)}</td>
                    <td className="py-2 pl-3 text-right">
                      {key.revokedAt ? (
                        <Badge variant="destructive">{t('apiKeys.revoked')}</Badge>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setConfirmRevoke({ id: key.id, name: key.name })}
                          disabled={revokingId === key.id}
                        >
                          {t('apiKeys.revoke')}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {createdToken && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 space-y-2">
          <p className="text-sm font-medium text-text">{t('apiKeys.tokenLabel')}</p>
          <div className="flex items-center gap-1.5">
            <code className="flex-1 min-w-0 truncate rounded bg-bg border border-border px-2 py-1.5 text-xs font-mono text-text">
              {createdToken.token}
            </code>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleCopyToken}
              aria-label={t('apiKeys.copyToken')}
              title={t('apiKeys.copyToken')}
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            </Button>
          </div>
          <p className="text-xs text-amber-600 dark:text-amber-400">{t('apiKeys.tokenWarning')}</p>
          <div className="flex justify-end">
            <Button size="sm" variant="ghost" onClick={() => setCreatedToken(null)}>
              {t('apiKeys.done')}
            </Button>
          </div>
        </div>
      )}

      {showCreateForm ? (
        <form onSubmit={handleCreate} className="space-y-3 border-t border-border pt-3">
          <Field label={t('apiKeys.nameLabel')} id="api-key-name">
            <Input
              id="api-key-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('apiKeys.namePlaceholder')}
              autoFocus
            />
          </Field>
          <div className="space-y-1.5">
            <span className="text-sm text-muted">{t('apiKeys.columnScopes')}</span>
            <div className="flex flex-wrap gap-4">
              {API_KEY_SCOPES.map((scope) => (
                <label key={scope} className="flex items-center gap-2 text-sm text-text">
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope)}
                    onChange={() => toggleScope(scope)}
                    className="rounded border-border"
                  />
                  {t(SCOPE_LABEL[scope])}
                </label>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="outline" onClick={resetForm}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={creating || !name.trim() || scopes.length === 0}
            >
              {creating ? t('apiKeys.creating') : t('common.create')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={() => setShowCreateForm(true)}>
            {t('apiKeys.createButton')}
          </Button>
        </div>
      )}

      {confirmRevoke && (
        <ConfirmDialog
          title={t('apiKeys.revokeTitle')}
          message={`${t('apiKeys.revokeTitle')} "${confirmRevoke.name}"? ${t('common.cannotBeUndone')}`}
          confirmLabel={t('apiKeys.revoke')}
          onConfirm={() => {
            handleRevoke(confirmRevoke.id)
            setConfirmRevoke(null)
          }}
          onCancel={() => setConfirmRevoke(null)}
        />
      )}
    </ServiceCard>
  )
}
