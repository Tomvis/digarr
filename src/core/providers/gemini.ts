import type { AiRecommendation, TasteProfile } from '@/core/types'
import { errMsg } from '@/core/validation'
import {
  buildRecommendationPrompt,
  getAiRecommendationsJsonSchema,
  parseRecommendationResponse,
} from './prompt'
import { fetchWithRetry } from './retry'
import { timeoutSecondsWithDefaultToMs } from './timeout'
import type { AiUsage, RecommendationProvider } from './types'

const DEFAULT_MODEL = 'gemini-3-flash-preview'
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const DEFAULT_TIMEOUT_SECONDS = 60
// Headroom for a full 15-20 artist response. The old 4096 was not enough once
// thinking tokens were counted against it (see thinkingConfig below); a complete
// 18-recommendation body measures ~2500 output tokens, so this leaves ~6x room
// without being an open cheque -- the request still stops rather than running on.
const MAX_OUTPUT_TOKENS = 16384
// 0 disables Gemini 3.x thinking. Every currently-served Gemini model accepts
// this field; if a future model requires a non-zero budget, raise it here rather
// than removing it, or the truncation bug returns.
const THINKING_BUDGET = 0

// Gemini's responseSchema is a subset of JSON Schema and rejects fields like
// `$schema`, `additionalProperties`, `exclusiveMinimum`, etc. Strip the ones
// that are known to cause 400s while keeping the shape-defining fields.
const GEMINI_DROP_KEYS = new Set([
  '$schema',
  '$id',
  'additionalProperties',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'default',
  'const',
  'examples',
  // `maxItems` on the top-level `recommendations` array (an array of OBJECTS)
  // is rejected by every currently-served Gemini model -- 3.5/3.6/3.7/3.8-flash
  // all answer `400 INVALID_ARGUMENT`, which fails the whole discover stage with
  // "[discover] AI source failed". It is positional, not blanket: `maxItems` on
  // the nested `genres` array (an array of STRINGS) is accepted, and `maxItems`
  // alone in a trivial schema is accepted. gemini-2.5-flash, which this
  // integration was evidently written against, took the original schema but is
  // now retired for new API keys, so there is no model left that works without
  // this. Dropped recursively rather than positionally: the bound is not lost,
  // because AiRecommendationArraySchema (.max(50)) and the genres array
  // (.max(25)) still validate every response after it is parsed.
  'maxItems',
])
function sanitizeGeminiSchema(input: unknown): unknown {
  if (Array.isArray(input)) return input.map((v) => sanitizeGeminiSchema(v))
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(input)) {
      if (GEMINI_DROP_KEYS.has(k)) continue
      out[k] = sanitizeGeminiSchema(v)
    }
    return out
  }
  return input
}

export class GeminiProvider implements RecommendationProvider {
  private apiKey: string
  private model: string
  private timeoutMs: number
  lastUsage: AiUsage | null = null

  constructor(apiKey: string, model: string = DEFAULT_MODEL, timeoutSeconds?: number | null) {
    this.apiKey = apiKey
    this.model = model
    this.timeoutMs = timeoutSecondsWithDefaultToMs(timeoutSeconds, DEFAULT_TIMEOUT_SECONDS)
  }

  async getRecommendations(profile: TasteProfile): Promise<AiRecommendation[]> {
    this.lastUsage = null
    const prompt = buildRecommendationPrompt(profile)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetchWithRetry(
        `${API_BASE}/${this.model}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': this.apiKey,
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: 'application/json',
              responseSchema: sanitizeGeminiSchema(getAiRecommendationsJsonSchema()),
              maxOutputTokens: MAX_OUTPUT_TOKENS,
              // Gemini 3.x bills *thinking* against maxOutputTokens. Measured on
              // 3.6-flash at the old 4096 cap, a trivial prompt spent 2669 tokens
              // on thoughts and only 1381 on output; a real taste profile then
              // truncates mid-JSON and the parser reports "Malformed JSON array
              // in AI response". Picking one artist list from a profile does not
              // need chain-of-thought, so the budget is spent on the answer.
              // Measured effect on the same prompt: 4110 total tokens and a
              // truncated body becomes 2566 total, finishReason STOP, 18 complete
              // recommendations -- both cheaper and correct.
              thinkingConfig: { thinkingBudget: THINKING_BUDGET },
            },
          }),
          signal: controller.signal,
        },
        { providerLabel: 'gemini' },
      )

      const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
        usageMetadata?: {
          promptTokenCount?: number
          candidatesTokenCount?: number
        }
      }
      if (data.usageMetadata) {
        this.lastUsage = {
          provider: 'gemini',
          model: this.model,
          inputTokens: data.usageMetadata.promptTokenCount,
          outputTokens: data.usageMetadata.candidatesTokenCount,
        }
      }
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text
      if (!text) throw new Error('Empty response from Gemini')

      // responseSchema does not guarantee well-formed output (truncation at
      // maxOutputTokens); the shared parser fails with a clear message instead.
      return parseRecommendationResponse(text)
    } finally {
      clearTimeout(timer)
    }
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const res = await fetch(`${API_BASE}/${this.model}:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'ping' }] }],
          generationConfig: { maxOutputTokens: 10 },
        }),
        signal: controller.signal,
      })

      if (res.ok) {
        return { success: true, message: `Connected to Gemini (${this.model})` }
      }
      const body = await res.text().catch(() => '')
      return { success: false, message: body || `HTTP ${res.status}` }
    } catch (err: unknown) {
      return {
        success: false,
        message: errMsg(err),
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
