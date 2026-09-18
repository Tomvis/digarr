# music-rater filters in digarr: genre and coverage type

> Status: approved design, not yet implemented
> Date: 2026-09-18
> Repos: digarr (primary) + music-rater (one dependency change)
> Builds on: `2026-09-16-music-rater-integration-design.md`

## Goal

Let the user control which albums the `critically-acclaimed` discovery mode
surfaces, by **genre** (include and exclude) and by **coverage type** — AMG's
editorial categories: Things You Might Have Missed, Sophomore In The
Foreground, You Might Insert Opinion, Album of the Year, Record of the Month,
and so on.

The option lists are **derived from the user's own synced corpus**, not
hardcoded and not fetched live, so digarr never carries a copy of
music-rater's taxonomy that can silently drift out of date, and never offers a
value that would return zero results.

## The constraint that shapes this

**Coverage types are unreachable today, structurally.** The corpus sync
requests `has_score=true`, and 3,343 of music-rater's 14,038 albums have no
scored occurrence at all. The categories the user asked for are precisely the
non-scored recommendation columns:

| post type | albums | | post type | albums |
|---|---|---|---|---|
| review | 10,483 | | rfu | 479 |
| aoty | 3,081 | | ymio | 112 |
| tymhm | 781 | | contrite | 74 |
| sitf | 497 | | lit (Lost in Time) | 50 |
| aotm | 496 | | | |

So they are filtered out before they ever reach digarr, and even if synced,
`maxScoreRatio >= minScoreRatio` would drop them because their score is null.
Reaching them therefore changes *what the corpus contains*, which is why this
is a design change rather than a new filter predicate.

## Component 1 — music-rater exposes coverage types

`AlbumSummary` gains `coverage_types: list[str]`: the distinct
`posts.post_type` values across the album's occurrences.

This is a near-exact sibling of the existing `sources` aggregate. The list
query at `src/music_rater/services/albums.py:888` already joins `Post` and
computes `func.array_agg(func.distinct(Post.source_site))`; `coverage_types`
is `func.array_agg(func.distinct(Post.post_type))` on that same join. **No
schema migration** — `posts.post_type` already exists.

It inherits the followed-sites narrowing applied to the occurrence join
(`albums.py:890-897`), so the types reported are only those from sites the
caller actually follows. That is the correct and consistent behaviour: a user
who does not follow TPS should not see `lit` offered.

**Post type, not occurrence type.** `OccurrenceType`
(`scored_review` / `list_entry` / `honorable_mention` / …) is a second,
orthogonal axis. It is deliberately out of scope; the user named post types.

## Component 2 — digarr syncs unscored albums

- Drop `has_score=true` from `listScoredAlbums`' query
  (`src/core/clients/music-rater.ts`).
- Map the new `coverage_types` field through to `MusicRaterAlbum`.
- Add `coverageTypes` (jsonb `string[]`) to `music_rater_albums`, with a
  hand-hardened migration (`IF NOT EXISTS`, per the repo invariant — drizzle
  emits bare DDL).
- Add it to the sync's `toRow` and to `upsertMusicRaterAlbums`'
  `onConflictDoUpdate` set-list.

**This must remain inert by default.** Two existing behaviours already
guarantee it, and both need a test pinning them:

1. `getUnresolvedAcclaimedAlbums` filters `maxScoreRatio >= minScoreRatio`,
   which excludes NULL — so unscored albums are invisible unless explicitly
   opted in.
2. `findMusicRaterScoresByNames` skips rows whose score is null, so the
   `criticScore` signal is unaffected by the corpus growing.

Corpus size for the household grows roughly 10,695 → 14,038 rows per user.

## Component 3 — a real multiselect renderer (frontend)

**`multiselect` currently ignores `options` entirely.**
`src/web/components/discovery-mode-form.tsx` consumes `field.options` only in
the `select` branch (single-value dropdown); `multiselect` falls through to a
plain `<input type="text">` with a comma-separated-values placeholder.

This is a pre-existing defect, not one this work introduces:
`modes/artist-relationships.ts` ships `relationshipTypes` as a `multiselect`
*with* `options`, and those options have always been silently discarded.

Add multiselect rendering that consumes `options`. **It must branch on whether
options were supplied:**

- options present → a picker (checkbox list) over those options
- options absent → the current comma-separated text input, unchanged

That branch is load-bearing. `seedArtists` (in `artist-relationships`,
`labels`, and `similar-artist-web`) is a `multiselect` with **no** options —
it is genuinely free text, because the user types artist names. Rendering it
as an empty picker would break three shipped modes.

This is one change to one shared component, with no per-mode code — the
property the mode registry exists to preserve. It also fixes
`relationshipTypes` as a side effect.

## Component 4 — per-user option resolution

`DiscoveryModeDefinition` gains:

```ts
resolveOptions?(userId: number): Promise<Record<string, DiscoveryFieldOption[]>>
```

keyed by field key. `src/server/routes/discovery-modes.ts` calls it for any
mode that declares one and merges the result into the serialised
`easyFields`/`advancedFields` before returning. The wire shape is unchanged.
Modes without a resolver are untouched, and the route stays correct for them
with no extra queries.

For `critically-acclaimed`, the resolver runs one query per axis against
`music_rater_albums` for that user: `SELECT DISTINCT unnest(genre_slugs)` and
`SELECT DISTINCT unnest(coverage_types)`, each ordered alphabetically by
value so the picker is stable between page loads.

**Failure behaviour:** a resolver that throws must not take down the modes
page. The route logs and serves the mode with empty options, which degrades to
the existing free-text input rather than an error.

## Component 5 — the fields

| key | type | default | semantics |
|---|---|---|---|
| `includeGenres` | multiselect | empty | empty = all genres; otherwise the album must overlap at least one |
| `excludeGenres` | multiselect | empty | album is dropped if it overlaps any; **exclude wins** over include |
| `coverageTypes` | multiselect | empty | empty = all types; otherwise must overlap at least one |
| `includeUnscored` | toggle | **false** | false reproduces today's behaviour exactly |

Predicates are jsonb-array overlap (`?|`) evaluated in the corpus query
**before** resolution, so a filtered-out album never costs MusicBrainz budget.
Postgres' `?|` takes a `text[]` right-hand side and matches elements of a JSON
array, which is what these columns hold. Drizzle has no builder for `?|`, so
these go through `sql` template fragments — parameterised, never interpolated,
and bound as a single array parameter rather than one per value (the
bind-parameter scaling trap the ownership filter already hit).

`includeUnscored = true` relaxes the score gate to
`(max_score_ratio >= minScoreRatio OR max_score_ratio IS NULL)`.

## Component 6 — labels, and not re-importing the drift problem

Option *values* come from the corpus. *Labels* are where a taxonomy copy could
creep back in, so:

- **Genres**: derive the label from the slug (`death-metal` → "Death Metal").
  A pure transform — no mapping table, nothing to drift, no i18n keys.
- **Coverage types**: a small known-slug → i18n-key map (`tymhm` → "Things You
  Might Have Missed", `aoty` → "Album of the Year", …), **falling back to the
  raw slug for any unknown value**.

The fallback is the important half. If music-rater adds a post type tomorrow,
it still appears in the picker and still filters correctly — it just shows
unprettified. Nothing silently disappears, which is the failure mode a
hardcoded allow-list would have.

Four new field labels plus the coverage-type labels, across all 15 locales.
German goes in the informal *du* register to match the `discoveryMode.*`
region (the file is majority-*Sie* overall; the region is not).

## Testing

- Corpus query: include-only, exclude-only, both with exclude winning,
  coverage-type overlap, and `includeUnscored` both ways.
- **Inertness**: default settings produce byte-for-byte the same candidate set
  as before the change. This is the test that protects the shipped feature.
- Option resolution returns only values present in *that* user's corpus, and
  is scoped per user (two users, different corpora).
- Unknown coverage type falls back to its raw slug rather than vanishing.
- Resolver failure degrades to empty options without failing the route.
- Frontend: a multiselect **with** options renders a picker; one **without**
  options still renders the free-text input (guards `seedArtists`).
- music-rater: `coverage_types` is present, distinct, and narrowed by
  followed sites.

## Out of scope

- **Source-site filtering.** `sourceSites` is already synced so it is nearly
  free to add later, but it was not requested, and music-rater already gates
  sites per user server-side.
- **Occurrence-type filtering** (the second, orthogonal axis).
- Any change to the `criticScore` signal — it already skips null scores.

## Risks

- The corpus grows ~31%. Small in absolute terms (14k rows/user) but it is a
  behaviour change to a nightly job, so the first sync after deploy is larger
  than usual.
- `has_score=true` is currently the only thing keeping unscored albums out. If
  the inertness test is not written, a future edit to the score predicate would
  silently expose 3,343 albums per user.
