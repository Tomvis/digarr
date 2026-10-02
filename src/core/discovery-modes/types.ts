import type { DiscoveryModeRequest } from './request'

export type DiscoveryFieldType = 'text' | 'number' | 'select' | 'multiselect' | 'toggle' | 'tags'

export type DiscoveryConfigField = {
  key: string
  label: string
  type: DiscoveryFieldType
  required?: boolean
  helpText?: string
  options?: Array<{ value: string; label: string }>
  /** Initial value for a fresh form (toggles otherwise start unchecked). */
  defaultValue?: boolean | string
  /** Number inputs: bounds and step (e.g. a 0-5 scale in half points). */
  min?: number
  max?: number
  step?: number
  /** Consecutive fields sharing a section render under one heading. */
  section?: string
}

export type DiscoveryAvailabilityKind = 'strict' | 'fallback'

export type DiscoveryModeStability = 'stable' | 'experimental'

type RawDiscoveryCandidateBase = {
  name: string
  mbid?: string
  sourceUrl?: string
  provenanceMode?: string
  provenanceProvider: string
  confidenceHint?: number
  explanationHint?: string
  fallbackUsed: boolean
  freshnessDate?: string
}

export type RawDiscoveryCandidate =
  | (RawDiscoveryCandidateBase & {
      candidateType: 'artist'
      artistName?: never
    })
  | (RawDiscoveryCandidateBase & {
      candidateType: 'release'
      artistName: string
      artistMbid: string
      releaseMbid?: string
      releaseGroupMbid?: string
    })

export type DiscoveryCandidate = RawDiscoveryCandidate & {
  provenanceMode: string
}

export type RawDiscoveryExecutionResult = {
  candidates: RawDiscoveryCandidate[]
}

export type DiscoveryExecutionResult = {
  candidates: DiscoveryCandidate[]
}

export type DiscoveryModeDefinition = {
  id: string
  label: string
  description: string
  availability: DiscoveryAvailabilityKind
  stability?: DiscoveryModeStability
  easyFields: DiscoveryConfigField[]
  advancedFields: DiscoveryConfigField[]
  prepare?: (request: DiscoveryModeRequest) => Promise<DiscoveryModeRequest>
  executor: (request: DiscoveryModeRequest) => Promise<RawDiscoveryExecutionResult>
  /**
   * Per-user option lists for this mode's config fields, keyed by field key.
   *
   * Resolved by the modes route at request time and merged into the
   * serialised fields, so the frontend renders them with no per-mode code.
   * Modes without a resolver are untouched and cost no extra queries.
   *
   * A resolver MUST NOT be load-bearing for correctness: the route degrades
   * to empty options when it throws, which renders as the free-text input.
   */
  resolveOptions?: (userId: number) => Promise<Record<string, DiscoveryConfigField['options']>>
}
