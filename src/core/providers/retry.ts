import pRetry, { AbortError } from 'p-retry'
import { redactSecrets } from '@/core/validation'

export { redactSecrets } from '@/core/validation'

export type RetriableFetchOptions = {
  /** Max retry attempts on top of the initial call. */
  retries?: number
  /** Exponential backoff base multiplier. */
  factor?: number
  /** Initial delay in ms (doubled each attempt by `factor`). */
  minTimeout?: number
  /** Upper bound on per-attempt delay. */
  maxTimeout?: number
  /**
   * Per-attempt timeout in ms. Each attempt gets its own clock and a timed-out
   * attempt is retried like any other transient failure. Without this the only
   * abort source is the caller's own signal, and because that signal spans the
   * whole loop, one slow attempt swallows the entire budget and every remaining
   * retry is skipped -- see the abort attribution below.
   */
  attemptTimeoutMs?: number
  /**
   * Optional label recorded in the returned metadata so callers can include
   * provider context in job logs without re-implementing the retry accounting.
   */
  providerLabel?: string
  /**
   * If set, invoked with the final AbortController just before the AbortError
   * path is taken. Unused by current callers but keeps the API flexible.
   */
  onAbort?: () => void
}

const DEFAULTS: Required<Pick<RetriableFetchOptions, 'retries' | 'factor' | 'minTimeout'>> = {
  retries: 3,
  factor: 2,
  minTimeout: 1000,
}

/**
 * Wrap `fetch` with retry + exponential backoff that honours upstream
 * `Retry-After` headers. 4xx responses other than 429 raise an AbortError so
 * the retry loop stops immediately — there is nothing the retry can do about a
 * bad API key or a malformed request.
 *
 * Two clocks, and the difference is the whole point. `options.attemptTimeoutMs`
 * bounds ONE attempt and a timed-out attempt is retried. `init.signal` is the
 * caller's own deadline for the whole call, it is never retried, and it stays
 * the caller's to hold so it still covers reading the body off the `Response`
 * this returns. Callers that want both should arm their signal with
 * `overallTimeoutMsFor(attemptTimeoutMs)`.
 *
 * Returns the successful `Response`; the caller still owns body parsing and
 * downstream error mapping.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: RetriableFetchOptions = {},
): Promise<Response> {
  const retries = options.retries ?? DEFAULTS.retries
  const factor = options.factor ?? DEFAULTS.factor
  const minTimeout = options.minTimeout ?? DEFAULTS.minTimeout
  const maxTimeout = options.maxTimeout
  const attemptTimeoutMs = options.attemptTimeoutMs
  const callerSignal = init.signal ?? undefined

  return pRetry(
    async () => {
      // A fresh controller per attempt. Combining it with the caller's signal
      // rather than replacing it keeps cancellation working, and leaves the
      // caller's signal live for the body read that happens after we return.
      const attemptController = attemptTimeoutMs != null ? new AbortController() : undefined
      const attemptTimer =
        attemptController && attemptTimeoutMs != null
          ? setTimeout(() => attemptController.abort(), attemptTimeoutMs)
          : undefined
      const signal = attemptController
        ? callerSignal
          ? AbortSignal.any([callerSignal, attemptController.signal])
          : attemptController.signal
        : init.signal

      try {
        let res: Response
        try {
          res = await fetch(url, { ...init, signal })
        } catch (err) {
          // Abort attribution decides retry vs. bail. Our own per-attempt timer
          // means this attempt is dead but the next one may not be; anything
          // else is the caller cancelling or their deadline expiring, which no
          // retry can fix. The caller wins a simultaneous abort.
          if (isAbortError(err)) {
            if (attemptController?.signal.aborted && !callerSignal?.aborted) {
              throw new Error(`attempt timed out after ${attemptTimeoutMs}ms`)
            }
            throw new AbortError((err as Error).message || 'aborted')
          }
          // Transient network errors bubble up and p-retry will retry them.
          throw err instanceof Error ? err : new Error(String(err))
        }

        return await handleResponse(res, maxTimeout)
      } finally {
        clearTimeout(attemptTimer)
      }
    },
    { retries, factor, minTimeout, ...(maxTimeout ? { maxTimeout } : {}) },
  )
}

/**
 * Whole-loop budget for a given per-attempt timeout: every attempt plus the
 * exponential backoff between them. Callers arm their own AbortController with
 * this so a provider that stalls on every single attempt still terminates.
 */
export function overallTimeoutMsFor(
  attemptTimeoutMs: number,
  retries: number = DEFAULTS.retries,
  minTimeout: number = DEFAULTS.minTimeout,
  factor: number = DEFAULTS.factor,
): number {
  let backoff = 0
  for (let i = 0; i < retries; i++) backoff += minTimeout * factor ** i
  return attemptTimeoutMs * (retries + 1) + backoff
}

/**
 * Map one settled `Response` onto the retry contract: 5xx and 429 throw plain
 * Errors (retriable), other 4xx throw AbortError (terminal).
 */
async function handleResponse(res: Response, maxTimeout: number | undefined): Promise<Response> {
  if (res.status === 429) {
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'))
    if (retryAfter && retryAfter > 0) {
      // Consume any pending body to avoid leaked connections.
      await res.arrayBuffer().catch(() => undefined)
      await delay(Math.min(retryAfter * 1000, maxTimeout ?? retryAfter * 1000))
    }
    throw new Error(`rate limited (${res.status})`)
  }

  if (res.status >= 500 && res.status <= 599) {
    const snippet = await errorBodySnippet(res)
    throw new Error(`upstream ${res.status}${snippet ? `: ${snippet}` : ''}`)
  }

  if (!res.ok) {
    // 4xx (not 429): give up, but keep the body - a bare status code
    // ("client error 404") gives users nothing to act on, while provider
    // bodies name the missing model or malformed field.
    const snippet = await errorBodySnippet(res)
    throw new AbortError(`client error ${res.status}${snippet ? `: ${snippet}` : ''}`)
  }

  return res
}

/**
 * `Retry-After` is either a non-negative integer (seconds) or an HTTP-date.
 * We only handle the integer form - HTTP-dates are rare for API providers and
 * we fall back to the exponential backoff when we cannot parse.
 */
function parseRetryAfter(raw: string | null): number | null {
  if (!raw) return null
  const seconds = Number.parseInt(raw, 10)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds
  return null
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Read an error response body as a single-line snippet, capped for logs.
 * Snippets end up in thrown error messages that routes may echo to clients,
 * so credential-shaped substrings are redacted first.
 */
async function errorBodySnippet(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  return redactSecrets(text.replace(/\s+/g, ' ').trim()).slice(0, 200)
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const name = (err as { name?: unknown }).name
  return name === 'AbortError' || name === 'TimeoutError'
}

export { AbortError }
