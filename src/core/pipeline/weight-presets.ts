import type { ScoringWeights } from '@/db/schema'

export const WEIGHT_PRESETS = {
  default: {
    consensus: 0.3,
    similarity: 0.25,
    genreOverlap: 0.2,
    aiConfidence: 0.15,
    feedbackBoost: 0.1,
    popularity: 0.0,
    criticScore: 0.0,
  },
  genre: {
    consensus: 0.4,
    similarity: 0.35,
    genreOverlap: 0.05,
    aiConfidence: 0.1,
    feedbackBoost: 0.1,
    popularity: 0.0,
    criticScore: 0.0,
  },
} satisfies Record<string, ScoringWeights>

export function resolveWeights(
  preset: string,
  overrides?: Record<string, number> | null,
): ScoringWeights {
  const base: ScoringWeights =
    (WEIGHT_PRESETS as Record<string, ScoringWeights>)[preset] ?? WEIGHT_PRESETS.default
  if (!overrides) return base
  // Only apply overrides for known weight keys (type-safe merge)
  const merged: ScoringWeights = { ...base }
  for (const key of Object.keys(base) as Array<keyof ScoringWeights>) {
    if (key in overrides) {
      merged[key] = overrides[key] as number
    }
  }
  return merged
}
