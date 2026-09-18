# music-rater Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user filter the `critically-acclaimed` discovery mode by genre (include/exclude) and by music-rater's editorial coverage types (TYMHM, SITF, YMIO, AOTY, …), choosing from option lists derived from their own synced corpus.

**Architecture:** music-rater exposes `coverage_types` per album (one aggregate on an existing join, no migration). digarr stops filtering the sync to scored albums, stores coverage types, and gains four new mode fields whose option lists are resolved per user from `music_rater_albums`. A new optional `resolveOptions` hook on `DiscoveryModeDefinition` lets the modes route enrich field options without any per-mode frontend code.

**Tech Stack:** digarr — Bun, TypeScript strict, Drizzle, Hono, React 19, Vitest, Biome. music-rater — FastAPI, SQLModel, async SQLAlchemy, Postgres, pytest.

**Spec:** `docs/superpowers/specs/2026-09-18-music-rater-filters-design.md`

## Global Constraints

- **digarr test command:** `bun run test`. Gates: `bun run typecheck`, `bun run lint`, `bun run i18n:check`, `bun run check:api-docs`. No external services needed. Baseline **3688 passing, 17 skipped**.
- **Known PRE-EXISTING digarr flakes** (not yours): `oidc-link`, `migrate-backend` ×2, `migrate-backend-failure`, `db-connect`. Re-run individually if they flap.
- **music-rater test command:** `.venv/bin/python -m pytest` — NEVER bare `python`/`python3` (system python is 3.9.6; project requires >=3.14; venv at `.venv`). Needs live Postgres + Redis on localhost. Lint: `ruff check src/ tests/`.
- **music-rater has pre-existing full-suite flakiness** under the shared Postgres (different tests fail on different runs, on `main` too). Verify your own files individually; do not chase unrelated failures.
- **Drizzle emits bare DDL** — every generated migration must get `IF NOT EXISTS` / `IF EXISTS` added by hand (`docs/ARCHITECTURE.md` invariant). `drizzle/0052_*.sql` shows the expected shape.
- **Identity PKs** are written `integer('id').primaryKey().generatedByDefaultAsIdentity()`.
- **15 locales, all mandatory and compile-enforced** (`MessageKey = keyof typeof en`): `en, es, fr, de, pt-BR, it, nl, ro, pl, tr, uk, ru, ja, ko, zh-CN`. German goes in the informal *du* register — the `discoveryMode.*` region of `de.ts` is du-dominant even though the file overall is majority-*Sie*.
- **Never bind one parameter per array element.** Pass arrays to Postgres as a single bound parameter (`sql.param(arr)`), as `getUnresolvedAcclaimedAlbums` already does for ownership.
- Verify commit claims with a **two-commit** diff (`git diff <base> HEAD --stat`). The one-commit form compares against the working tree and has produced a false pass on this branch before.

---

### Task 1: music-rater exposes `coverage_types`

**Files:**
- Modify: `src/music_rater/api/schemas/albums.py` (`AlbumSummary`)
- Modify: `src/music_rater/services/albums.py` (~`:888` aggregate, `~:904` select, and the row→DTO mapping)
- Test: `tests/test_api_albums_coverage_types.py` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `AlbumSummary.coverage_types: list[str]` — distinct `posts.post_type` values across the album's occurrences, narrowed by the caller's followed sites. Values come from `PostType`: `review, tymhm, aoty, aotm, sitf, ymio, contrite, lit, rfu`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_api_albums_coverage_types.py`. Follow the seeding idiom in `tests/test_api_albums_site_filter.py` (pre-boot `seed` hook, own engine, real commit) — read it first.

```python
"""GET /albums reports which editorial columns covered each album."""

from __future__ import annotations


async def test_coverage_types_are_distinct_and_present(api_client):
    r = await api_client.get("/api/v1/albums", params={"limit": 50})
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert items, "seed at least one album for this test"
    for item in items:
        assert "coverage_types" in item
        assert isinstance(item["coverage_types"], list)
        # distinct, and only real post types
        assert len(item["coverage_types"]) == len(set(item["coverage_types"]))
        for value in item["coverage_types"]:
            assert value in {
                "review", "tymhm", "aoty", "aotm",
                "sitf", "ymio", "contrite", "lit", "rfu",
            }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_api_albums_coverage_types.py -v`
Expected: FAIL — `assert "coverage_types" in item`.

- [ ] **Step 3: Add the schema field**

In `src/music_rater/api/schemas/albums.py`, on `AlbumSummary`, beside `sources`:

```python
    #: Distinct ``posts.post_type`` values covering this album, narrowed to
    #: the caller's followed sites (same narrowing as ``sources``). Lets a
    #: client distinguish a scored review from an editorial column pick such
    #: as ``tymhm`` -- which carries no score at all, so it cannot be
    #: reached by score filtering.
    coverage_types: list[str] = []
```

- [ ] **Step 4: Add the aggregate**

In `src/music_rater/services/albums.py`, beside `sources_agg` (~`:888`):

```python
    coverage_types_agg = func.array_agg(func.distinct(Post.post_type))
```

Add it to the `select(...)` at ~`:904` and to the `GROUP BY`-compatible projection, then thread it through the row→DTO mapping the same way `sources` is. `sources` goes through `clean_sources` (`services/_sources.py`); coverage types need the equivalent NULL-stripping, because the `outerjoin` yields `[None]` for an album with no matching occurrence. Mirror whatever `clean_sources` does rather than inventing a second cleaner.

- [ ] **Step 5: Run test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_api_albums_coverage_types.py -v`
Expected: PASS

- [ ] **Step 6: Confirm you broke nothing adjacent**

Run: `.venv/bin/python -m pytest tests/test_api_albums_site_filter.py tests/test_api_browse_filter_siblings.py tests/test_services_albums_dedup.py -v`
Expected: PASS. These exercise the same query.

Run: `ruff check src/ tests/`

- [ ] **Step 7: Commit**

```bash
git add src/music_rater/api/schemas/albums.py src/music_rater/services/albums.py tests/test_api_albums_coverage_types.py
git commit -m "feat(albums): report coverage_types per album"
```

---

### Task 2: digarr syncs unscored albums and stores coverage types

**Files:**
- Modify: `src/core/clients/music-rater.ts`
- Modify: `src/db/schema.ts` (`musicRaterAlbums`)
- Create: `drizzle/<generated>_music_rater_coverage_types.sql`
- Modify: `src/core/music-rater/sync.ts` (`MusicRaterAlbumRow`, `toRow`)
- Modify: `src/db/queries/music-rater.ts` (`upsertMusicRaterAlbums` set-list)
- Test: `tests/core/music-rater/sync.test.ts`, `tests/core/clients/music-rater.test.ts`, `tests/db/queries/music-rater.test.ts`

**Interfaces:**
- Consumes: `AlbumSummary.coverage_types` (Task 1).
- Produces: `MusicRaterAlbum.coverageTypes: string[]`; `music_rater_albums.coverage_types` (jsonb `string[]`); `MusicRaterAlbumRow.coverageTypes`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/core/clients/music-rater.test.ts`:

```ts
  it('no longer restricts the corpus to scored albums', async () => {
    mockFetch.mockResolvedValueOnce(jsonOk({ items: [], total: 0, limit: 500, offset: 0 }))
    await createMusicRaterClient('http://mr.example', 'mr_k').listScoredAlbums(0)
    const url = mockFetch.mock.calls[0]?.[0] as string
    expect(url).not.toContain('has_score')
  })

  it('maps coverage_types through, defaulting to an empty array', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonOk({
        items: [
          {
            id: 7,
            artist_name_raw: 'A',
            album_title_raw: 'B',
            release_year: 1999,
            max_score_ratio: null,
            genre_slugs: [],
            sources: ['amg'],
            coverage_types: ['tymhm'],
          },
          {
            id: 8,
            artist_name_raw: 'C',
            album_title_raw: 'D',
            release_year: 2000,
            sources: [],
          },
        ],
        total: 2,
        limit: 500,
        offset: 0,
      }),
    )
    const page = await createMusicRaterClient('http://mr.example', 'mr_k').listScoredAlbums(0)
    expect(page.items[0]?.coverageTypes).toEqual(['tymhm'])
    expect(page.items[1]?.coverageTypes).toEqual([])
  })
```

Add to `tests/core/music-rater/sync.test.ts`:

```ts
  it('carries coverage types onto the upserted row', async () => {
    const listScoredAlbums = vi.fn().mockResolvedValueOnce({
      items: [album(1, { coverageTypes: ['tymhm', 'aoty'] })],
      total: 1,
    })
    const upsert = vi.fn().mockResolvedValue(undefined)

    await syncMusicRaterCorpus({ client: { listScoredAlbums }, upsert }, 1)

    expect(upsert.mock.calls[0]?.[1][0].coverageTypes).toEqual(['tymhm', 'aoty'])
  })
```

> The `album()` helper in that file needs `coverageTypes: []` added to its defaults.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test tests/core/clients/music-rater.test.ts tests/core/music-rater/sync.test.ts`
Expected: FAIL — `has_score` still present; `coverageTypes` undefined.

- [ ] **Step 3: Update the client**

In `src/core/clients/music-rater.ts`: add `coverage_types?: string[]` to `RawAlbumSummary`, add `coverageTypes: string[]` to `MusicRaterAlbum`, map it in `toAlbum` as `raw.coverage_types ?? []`, and **remove `has_score=true`** from the query string in `listScoredAlbums`.

Replace the now-stale comment about scored albums with one saying why the whole corpus is synced: the editorial columns (`tymhm`, `sitf`, `ymio`, `lit`) carry no score, so `has_score=true` made them permanently unreachable. Note that unscored rows stay invisible to the discovery mode until `includeUnscored` is turned on (Task 5).

- [ ] **Step 4: Add the column and migration**

In `src/db/schema.ts`, on `musicRaterAlbums`, beside `sourceSites`:

```ts
    coverageTypes: jsonb('coverage_types').$type<string[]>(),
```

Then `bun run db:generate` and hand-edit the emitted SQL to `ADD COLUMN IF NOT EXISTS`.

- [ ] **Step 5: Thread it through sync and upsert**

Add `coverageTypes: string[]` to `MusicRaterAlbumRow` and set it in `toRow` from `album.coverageTypes`. Add `coverageTypes: sql\`excluded.coverage_types\`` to `upsertMusicRaterAlbums`' `onConflictDoUpdate` set-list.

**Do NOT add any `resolved_*` column to that set-list** — the existing comment explains why (a resync must not clobber MusicBrainz resolution state).

- [ ] **Step 6: Write the inertness test**

This is the test that protects the shipped feature. Add to `tests/db/queries/music-rater.test.ts` (real pglite):

```ts
  it('leaves unscored albums invisible to the mode by default', async () => {
    // A corpus row with no score is exactly what the editorial columns
    // (tymhm/sitf/ymio/lit) produce. Until includeUnscored is turned on it
    // must not be a candidate, or dropping has_score=true would silently
    // change what every existing run returns.
    const db = await makeTestDb()
    await upsertMusicRaterAlbums(db, 1, [
      row({ musicRaterAlbumId: 1, maxScoreRatio: null, releaseYear: 2020 }),
      row({ musicRaterAlbumId: 2, maxScoreRatio: 0.95, releaseYear: 2020 }),
    ])

    const found = await getUnresolvedAcclaimedAlbums(db, 1, {
      minScoreRatio: 0.8,
      minReleaseYear: 2000,
      limit: 25,
    })

    expect(found).toHaveLength(1)
  })
```

> Match that file's existing `makeTestDb()` / row-builder helpers rather than inventing new ones — read the top of the file first. If its rows are built by a local helper with a different name, use that.

- [ ] **Step 7: Run the tests**

Run: `bun run test tests/core/clients/music-rater.test.ts tests/core/music-rater/sync.test.ts tests/db/queries/music-rater.test.ts`
Expected: PASS

Then `bun run typecheck && bun run lint`, then the full `bun run test`.

- [ ] **Step 8: Commit**

```bash
git add src/core/clients/music-rater.ts src/db/schema.ts drizzle/ src/core/music-rater/sync.ts src/db/queries/music-rater.ts tests/
git commit -m "feat(music-rater): sync the whole corpus and store coverage types"
```

---

### Task 3: a real multiselect renderer

**Files:**
- Modify: `src/web/components/discovery-mode-form.tsx`
- Test: `tests/web/components/discovery-mode-form.test.tsx` (create if absent)

**Interfaces:**
- Consumes: nothing.
- Produces: a `multiselect` field **with** `options` renders a checkbox picker; **without** options it keeps the existing comma-separated text input.

> **Why this task exists:** `field.options` is currently consumed only by the `select` branch. `multiselect` falls through to `<input type="text">`, so options are silently discarded. `modes/artist-relationships.ts` has shipped `relationshipTypes` as a multiselect *with* options all along, and they have never rendered.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DiscoveryModeForm } from '@/web/components/discovery-mode-form'

// Match the existing render helpers/props in this repo's web tests; read a
// sibling test (e.g. tests/web/pages/settings.test.tsx) for the wrapper idiom.

describe('multiselect rendering', () => {
  it('renders a picker when the field supplies options', () => {
    renderForm({
      fields: [
        {
          key: 'coverageTypes',
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
  })

  it('keeps the free-text input when the field supplies no options', () => {
    renderForm({
      fields: [{ key: 'seedArtists', label: 'Seed artists', type: 'multiselect', required: true }],
    })
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByLabelText(/Seed artists/)).toHaveProperty('tagName', 'INPUT')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test tests/web/components/discovery-mode-form.test.tsx`
Expected: FAIL — no checkbox is rendered; the picker branch does not exist.

- [ ] **Step 3: Add the branch**

In `discovery-mode-form.tsx`, add a `multiselect`-with-options branch before the final fallback `<input>`. Keep the stored value in the **same comma-separated string format** the existing free-text input uses, so nothing downstream (`normalizedSettings`, saved subscriptions, the executor) has to change:

```tsx
            ) : field.type === 'multiselect' && (field.options?.length ?? 0) > 0 ? (
              <div
                role="group"
                aria-labelledby={`${inputId}-label`}
                aria-describedby={helpId}
                className="flex flex-col gap-1"
              >
                {(field.options ?? []).map((option) => {
                  const selected = String(value)
                    .split(',')
                    .map((v) => v.trim())
                    .filter(Boolean)
                  const checked = selected.includes(option.value)
                  return (
                    <label key={option.value} className="flex items-center gap-2 text-sm text-text">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => {
                          const next = event.target.checked
                            ? [...selected, option.value]
                            : selected.filter((v) => v !== option.value)
                          setValues((prev) => ({ ...prev, [field.key]: next.join(',') }))
                        }}
                        className="h-4 w-4 rounded border-border"
                      />
                      {translateDiscoveryOption(tFn, option)}
                    </label>
                  )
                })}
              </div>
            ) : (
```

**The `(field.options?.length ?? 0) > 0` guard is load-bearing.** `seedArtists` is a `multiselect` with no options in `artist-relationships`, `labels` and `similar-artist-web` — it is genuinely free text (the user types artist names). Rendering it as an empty picker would break three shipped modes.

Ensure the field's `<label>` carries `id={`${inputId}-label`}` so the group is named; check how the existing label element is rendered and add the id there.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test tests/web/components/discovery-mode-form.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 5: Confirm the three seedArtists modes still work**

Run: `bun run test tests/web/ tests/core/discovery-modes/`
Expected: PASS. Also run `bun run test:e2e:a11y` if it is quick in this environment; a checkbox group needs an accessible name.

- [ ] **Step 6: Commit**

```bash
git add src/web/components/discovery-mode-form.tsx tests/web/components/discovery-mode-form.test.tsx
git commit -m "fix(discovery-modes): render multiselect options instead of discarding them"
```

---

### Task 4: per-user option resolution

**Files:**
- Modify: `src/core/discovery-modes/types.ts` (`DiscoveryModeDefinition`)
- Modify: `src/server/routes/discovery-modes.ts`
- Test: `tests/server/routes/discovery-modes.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `DiscoveryModeDefinition.resolveOptions?: (userId: number) => Promise<Record<string, DiscoveryConfigField['options']>>`. The route merges the returned options into the serialised `easyFields`/`advancedFields` by field key.

- [ ] **Step 1: Write the failing test**

```ts
  it('merges per-user options into the mode fields', async () => {
    const mode = {
      id: 'test-mode',
      label: 'Test',
      description: '',
      availability: 'strict' as const,
      easyFields: [{ key: 'genres', label: 'Genres', type: 'multiselect' as const }],
      advancedFields: [],
      resolveOptions: async () => ({
        genres: [{ value: 'doom-metal', label: 'Doom Metal' }],
      }),
      executor: async () => ({ candidates: [] }),
    }
    const res = await requestModes({ modes: [mode] })
    const body = await res.json()
    expect(body.modes[0].easyFields[0].options).toEqual([
      { value: 'doom-metal', label: 'Doom Metal' },
    ])
  })

  it('serves the mode with empty options when the resolver throws', async () => {
    const mode = {
      id: 'test-mode',
      label: 'Test',
      description: '',
      availability: 'strict' as const,
      easyFields: [{ key: 'genres', label: 'Genres', type: 'multiselect' as const }],
      advancedFields: [],
      resolveOptions: async () => {
        throw new Error('db down')
      },
      executor: async () => ({ candidates: [] }),
    }
    const res = await requestModes({ modes: [mode] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.modes[0].easyFields[0].options ?? []).toEqual([])
  })
```

> Match the file's existing helper for building the app and issuing a request; read it first rather than inventing `requestModes`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test tests/server/routes/discovery-modes.test.ts`
Expected: FAIL — options are undefined; `resolveOptions` is not a known property.

- [ ] **Step 3: Extend the definition type**

In `src/core/discovery-modes/types.ts`, on `DiscoveryModeDefinition`:

```ts
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
```

- [ ] **Step 4: Wire the route**

In `src/server/routes/discovery-modes.ts`, the `.map(...)` becomes async. Replace it with:

```ts
    const modes = await Promise.all(
      discoveryModeRegistry.list().map(async (mode) => {
        // A resolver reaches the database, so it must not be able to fail the
        // whole modes page. Degrading to empty options renders the field as
        // the free-text input, which is exactly the pre-resolver behaviour.
        let resolved: Record<string, DiscoveryConfigField['options']> = {}
        if (mode.resolveOptions) {
          try {
            resolved = await mode.resolveOptions(userId)
          } catch (err) {
            console.error(`[discovery-modes] resolveOptions failed for ${mode.id}`, err)
          }
        }
        const withOptions = (fields: DiscoveryConfigField[]) =>
          fields.map((field) =>
            resolved[field.key] ? { ...field, options: resolved[field.key] } : field,
          )

        return {
          id: mode.id,
          label: mode.label,
          description: mode.description,
          availability: evaluateDiscoveryModeAvailability(mode.id, snapshot),
          stability: mode.stability ?? 'stable',
          easyFields: withOptions(mode.easyFields),
          advancedFields: withOptions(mode.advancedFields),
        }
      }),
    )
```

Import `DiscoveryConfigField` from `@/core/discovery-modes/types`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run test tests/server/routes/discovery-modes.test.ts`
Expected: PASS

Then `bun run typecheck && bun run lint && bun run check:api-docs`.

- [ ] **Step 6: Commit**

```bash
git add src/core/discovery-modes/types.ts src/server/routes/discovery-modes.ts tests/server/routes/discovery-modes.test.ts
git commit -m "feat(discovery-modes): per-user field options via resolveOptions"
```

---

### Task 5: the four filter fields and their query predicates

**Files:**
- Modify: `src/db/queries/music-rater.ts` (`getUnresolvedAcclaimedAlbums`)
- Modify: `src/core/discovery-modes/modes/critically-acclaimed.ts`
- Modify: all 15 of `src/core/i18n/messages/*.ts`
- Test: `tests/db/queries/music-rater.test.ts`, `tests/core/discovery-modes/critically-acclaimed.test.ts`

**Interfaces:**
- Consumes: `music_rater_albums.coverage_types` (Task 2).
- Produces: `getUnresolvedAcclaimedAlbums(db, userId, opts)` where `opts` gains `includeGenres: string[]`, `excludeGenres: string[]`, `coverageTypes: string[]`, `includeUnscored: boolean`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/db/queries/music-rater.test.ts` (real pglite; reuse the file's existing helpers):

```ts
const BASE = { minScoreRatio: 0.8, minReleaseYear: 2000, limit: 25 }
const NO_FILTERS = { includeGenres: [], excludeGenres: [], coverageTypes: [], includeUnscored: false }

it('treats empty filter arrays as no constraint', async () => {
  // The default path. If this ever fails, the feature has stopped being
  // inert for every user who has not touched the new fields.
  const db = await makeTestDb()
  await upsertMusicRaterAlbums(db, 1, [
    row({ musicRaterAlbumId: 1, maxScoreRatio: 0.9, releaseYear: 2020, genreSlugs: ['doom-metal'] }),
    row({ musicRaterAlbumId: 2, maxScoreRatio: 0.9, releaseYear: 2020, genreSlugs: ['power-metal'] }),
  ])

  const found = await getUnresolvedAcclaimedAlbums(db, 1, { ...BASE, ...NO_FILTERS })
  expect(found).toHaveLength(2)
})

it('includes only albums overlapping includeGenres', async () => {
  const db = await makeTestDb()
  await upsertMusicRaterAlbums(db, 1, [
    row({ musicRaterAlbumId: 1, maxScoreRatio: 0.9, releaseYear: 2020, albumTitleRaw: 'Doomy', genreSlugs: ['doom-metal'] }),
    row({ musicRaterAlbumId: 2, maxScoreRatio: 0.9, releaseYear: 2020, albumTitleRaw: 'Powery', genreSlugs: ['power-metal'] }),
  ])

  const found = await getUnresolvedAcclaimedAlbums(db, 1, {
    ...BASE, ...NO_FILTERS, includeGenres: ['doom-metal'],
  })
  expect(found.map((r) => r.albumTitleRaw)).toEqual(['Doomy'])
})

it('drops albums overlapping excludeGenres', async () => {
  const db = await makeTestDb()
  await upsertMusicRaterAlbums(db, 1, [
    row({ musicRaterAlbumId: 1, maxScoreRatio: 0.9, releaseYear: 2020, albumTitleRaw: 'Doomy', genreSlugs: ['doom-metal'] }),
    row({ musicRaterAlbumId: 2, maxScoreRatio: 0.9, releaseYear: 2020, albumTitleRaw: 'Powery', genreSlugs: ['power-metal'] }),
  ])

  const found = await getUnresolvedAcclaimedAlbums(db, 1, {
    ...BASE, ...NO_FILTERS, excludeGenres: ['power-metal'],
  })
  expect(found.map((r) => r.albumTitleRaw)).toEqual(['Doomy'])
})

it('lets exclude win over include on the same album', async () => {
  // Tagged BOTH. Include says yes, exclude says no -- exclude is the
  // stronger statement, so the album must not be returned.
  const db = await makeTestDb()
  await upsertMusicRaterAlbums(db, 1, [
    row({
      musicRaterAlbumId: 1, maxScoreRatio: 0.9, releaseYear: 2020,
      genreSlugs: ['progressive-metal', 'swedish-metal'],
    }),
  ])

  const found = await getUnresolvedAcclaimedAlbums(db, 1, {
    ...BASE, ...NO_FILTERS,
    includeGenres: ['progressive-metal'],
    excludeGenres: ['swedish-metal'],
  })
  expect(found).toHaveLength(0)
})

it('includes only albums overlapping coverageTypes', async () => {
  const db = await makeTestDb()
  await upsertMusicRaterAlbums(db, 1, [
    row({ musicRaterAlbumId: 1, maxScoreRatio: 0.9, releaseYear: 2020, albumTitleRaw: 'Missed', coverageTypes: ['tymhm'] }),
    row({ musicRaterAlbumId: 2, maxScoreRatio: 0.9, releaseYear: 2020, albumTitleRaw: 'Reviewed', coverageTypes: ['review'] }),
  ])

  const found = await getUnresolvedAcclaimedAlbums(db, 1, {
    ...BASE, ...NO_FILTERS, coverageTypes: ['tymhm'],
  })
  expect(found.map((r) => r.albumTitleRaw)).toEqual(['Missed'])
})

it('admits unscored albums only when includeUnscored is true', async () => {
  const db = await makeTestDb()
  await upsertMusicRaterAlbums(db, 1, [
    row({ musicRaterAlbumId: 1, maxScoreRatio: 0.9, releaseYear: 2020, albumTitleRaw: 'Scored' }),
    row({ musicRaterAlbumId: 2, maxScoreRatio: null, releaseYear: 2020, albumTitleRaw: 'Unscored', coverageTypes: ['tymhm'] }),
  ])

  const off = await getUnresolvedAcclaimedAlbums(db, 1, { ...BASE, ...NO_FILTERS })
  expect(off.map((r) => r.albumTitleRaw)).toEqual(['Scored'])

  const on = await getUnresolvedAcclaimedAlbums(db, 1, { ...BASE, ...NO_FILTERS, includeUnscored: true })
  expect(on.map((r) => r.albumTitleRaw).sort()).toEqual(['Scored', 'Unscored'])
})
```

> `row(...)` and `makeTestDb()` stand for this file's existing helpers — read the
> top of `tests/db/queries/music-rater.test.ts` and use whatever it actually
> defines rather than adding new ones. If its row builder does not accept
> `genreSlugs`/`coverageTypes`, extend it rather than bypassing it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test tests/db/queries/music-rater.test.ts`
Expected: FAIL — `opts` has no such properties.

- [ ] **Step 3: Extend the query**

In `getUnresolvedAcclaimedAlbums`, widen `opts` and add predicates. Build them conditionally so an empty array adds no SQL at all:

```ts
  const filters = [
    eq(musicRaterAlbums.userId, userId),
    isNull(musicRaterAlbums.resolvedReleaseGroupMbid),
    gte(musicRaterAlbums.releaseYear, opts.minReleaseYear),
    notOwned,
  ]

  // An unscored album is what the editorial columns (tymhm/sitf/ymio/lit)
  // produce -- they carry no rating at all. Off by default so the corpus
  // growing does not change what existing runs return.
  filters.push(
    opts.includeUnscored
      ? sql`(${musicRaterAlbums.maxScoreRatio} >= ${opts.minScoreRatio} OR ${musicRaterAlbums.maxScoreRatio} IS NULL)`
      : gte(musicRaterAlbums.maxScoreRatio, opts.minScoreRatio),
  )

  // `?|` matches any element of the stored JSON array against a text[] passed
  // as ONE bound parameter -- never one parameter per value.
  if (opts.includeGenres.length > 0) {
    filters.push(sql`${musicRaterAlbums.genreSlugs} ?| ${sql.param(opts.includeGenres)}::text[]`)
  }
  if (opts.excludeGenres.length > 0) {
    filters.push(
      sql`NOT (${musicRaterAlbums.genreSlugs} ?| ${sql.param(opts.excludeGenres)}::text[])`,
    )
  }
  if (opts.coverageTypes.length > 0) {
    filters.push(sql`${musicRaterAlbums.coverageTypes} ?| ${sql.param(opts.coverageTypes)}::text[]`)
  }
```

Exclude wins because both predicates are ANDed: an album matching both is dropped by the `NOT`.

> If `?|` rejects a `jsonb` left-hand side in this pglite/Postgres version, fall back to
> `EXISTS (SELECT 1 FROM jsonb_array_elements_text(col) e WHERE e = ANY(param))`, which is
> equivalent and still one bound parameter. Say in your report which form you used and why.

- [ ] **Step 4: Add the mode fields**

In `critically-acclaimed.ts`:

```ts
    easyFields: [
      { key: 'minScoreRatio', label: 'Minimum score (0-1)', type: 'number' },
      { key: 'minReleaseYear', label: 'Released since', type: 'number' },
      { key: 'includeGenres', label: 'Only these genres', type: 'multiselect' },
      { key: 'excludeGenres', label: 'Never these genres', type: 'multiselect' },
      { key: 'coverageTypes', label: 'Only these kinds of coverage', type: 'multiselect' },
    ],
    advancedFields: [
      { key: 'maxAlbumsPerRun', label: 'Albums resolved per run', type: 'number' },
      { key: 'includeUnscored', label: 'Include unscored recommendations', type: 'toggle' },
    ],
```

Add a `listSetting(value)` helper beside the existing `numberSetting` that parses the comma-separated multiselect string into `string[]`, trimming and dropping empties, and thread all four into the `getUnresolvedAcclaimedAlbums` call. `includeUnscored` is `settings.includeUnscored === true`.

- [ ] **Step 5: Add the field labels to all 15 locales**

Add to `src/core/i18n/messages/en.ts` beside `discoveryMode.field.minScoreRatio`:

```ts
  'discoveryMode.field.includeGenres': 'Only these genres',
  'discoveryMode.field.excludeGenres': 'Never these genres',
  'discoveryMode.field.coverageTypes': 'Only these kinds of coverage',
  'discoveryMode.field.includeUnscored': 'Include unscored recommendations',
```

Then the same four keys, translated, in the other 14. `bun run typecheck` enumerates any you miss. German in the informal *du* register.

- [ ] **Step 6: Run the tests and gates**

Run: `bun run test tests/db/queries/music-rater.test.ts tests/core/discovery-modes/critically-acclaimed.test.ts`
Then: `bun run typecheck && bun run lint && bun run i18n:check`
Then the full `bun run test`.

- [ ] **Step 7: Commit**

```bash
git add src/db/queries/music-rater.ts src/core/discovery-modes/modes/critically-acclaimed.ts src/core/i18n/ tests/
git commit -m "feat(critically-acclaimed): genre, coverage-type and unscored filters"
```

---

### Task 6: resolve the option lists from the corpus

**Files:**
- Modify: `src/db/queries/music-rater.ts` (new query)
- Modify: `src/core/discovery-modes/modes/critically-acclaimed.ts` (`resolveOptions`)
- Modify: all 15 of `src/core/i18n/messages/*.ts` (coverage-type option labels)
- Test: `tests/db/queries/music-rater.test.ts`, `tests/core/discovery-modes/critically-acclaimed.test.ts`

**Interfaces:**
- Consumes: `resolveOptions` hook (Task 4); `coverage_types` column (Task 2).
- Produces: `getMusicRaterFilterOptions(db, userId): Promise<{ genres: string[]; coverageTypes: string[] }>` — distinct values present in that user's corpus, each sorted alphabetically.

- [ ] **Step 1: Write the failing tests**

```ts
  it('offers only values present in that user’s corpus', async () => {
    const db = await makeTestDb()
    await upsertMusicRaterAlbums(db, 1, [row({ musicRaterAlbumId: 1, genreSlugs: ['doom-metal'], coverageTypes: ['tymhm'] })])
    await upsertMusicRaterAlbums(db, 2, [row({ musicRaterAlbumId: 1, genreSlugs: ['power-metal'], coverageTypes: ['aoty'] })])

    const opts = await getMusicRaterFilterOptions(db, 1)
    expect(opts.genres).toEqual(['doom-metal'])
    expect(opts.coverageTypes).toEqual(['tymhm'])
  })

  it('returns distinct values sorted alphabetically', async () => {
    const db = await makeTestDb()
    await upsertMusicRaterAlbums(db, 1, [
      row({ musicRaterAlbumId: 1, genreSlugs: ['doom-metal', 'black-metal'] }),
      row({ musicRaterAlbumId: 2, genreSlugs: ['black-metal'] }),
    ])
    expect((await getMusicRaterFilterOptions(db, 1)).genres).toEqual(['black-metal', 'doom-metal'])
  })
```

And in the mode test:

```ts
  it('labels a known coverage type and falls back to the raw slug for an unknown one', async () => {
    const mode = createCriticallyAcclaimedMode({
      // Only getFilterOptions is exercised here; the rest satisfy the deps
      // type. Reuse this file's existing baseDeps(...) helper if it has one.
      getUnresolvedAcclaimedAlbums: vi.fn().mockResolvedValue([]),
      resolveArtistMbid: vi.fn(),
      matchAlbum: vi.fn(),
      markResolved: vi.fn(),
      recordResolutionFailure: vi.fn(),
      isAlbumOwned: vi.fn(),
      getFilterOptions: async () => ({ genres: ['death-metal'], coverageTypes: ['tymhm', 'brand-new-thing'] }),
    })
    const options = await mode.resolveOptions!(1)
    expect(options.includeGenres).toEqual([{ value: 'death-metal', label: 'Death Metal' }])
    expect(options.coverageTypes).toEqual([
      { value: 'tymhm', label: 'Things You Might Have Missed' },
      { value: 'brand-new-thing', label: 'brand-new-thing' },
    ])
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test tests/db/queries/music-rater.test.ts tests/core/discovery-modes/critically-acclaimed.test.ts`
Expected: FAIL — `getMusicRaterFilterOptions` is not defined; `resolveOptions` is undefined.

- [ ] **Step 3: Add the query**

```ts
/**
 * The distinct genre slugs and coverage types present in this user's synced
 * corpus, for the mode's option pickers.
 *
 * Deliberately corpus-derived rather than fetched from music-rater: digarr
 * then carries no copy of music-rater's taxonomy that can drift, and never
 * offers a value that would return zero results for this user (their corpus
 * is already narrowed by their followed sites and score thresholds).
 */
export async function getMusicRaterFilterOptions(
  db: Database,
  userId: number,
): Promise<{ genres: string[]; coverageTypes: string[] }> {
  const rows = await db.execute(sql`
    SELECT
      (SELECT coalesce(array_agg(DISTINCT g ORDER BY g), '{}')
         FROM ${musicRaterAlbums} a2, jsonb_array_elements_text(a2.genre_slugs) g
        WHERE a2.user_id = ${userId}) AS genres,
      (SELECT coalesce(array_agg(DISTINCT c ORDER BY c), '{}')
         FROM ${musicRaterAlbums} a3, jsonb_array_elements_text(a3.coverage_types) c
        WHERE a3.user_id = ${userId}) AS coverage_types
  `)
  const first = (rows as unknown as { rows: Array<Record<string, string[]>> }).rows?.[0]
  return { genres: first?.genres ?? [], coverageTypes: first?.coverage_types ?? [] }
}
```

> `db.execute`'s result shape differs between the pg and PGlite drivers. Check how another raw query in `src/db/queries/` unwraps it and match that; if none exists, verify the shape in the pglite test before relying on `.rows`.

- [ ] **Step 4: Add the resolver and the label helpers**

In `critically-acclaimed.ts`:

```ts
/** `death-metal` -> `Death Metal`. A pure transform, so there is no genre
 *  taxonomy to keep in sync and no i18n key per genre. */
function genreLabel(slug: string): string {
  return slug
    .split('-')
    .map((part) => (part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ')
}

/** Coverage types get real names via i18n. An UNKNOWN slug falls through to
 *  itself rather than disappearing: if music-rater adds a post type, it still
 *  appears in the picker and still filters -- just unprettified. */
const COVERAGE_TYPE_LABELS: Record<string, string> = {
  review: 'discoveryMode.option.coverageReview',
  tymhm: 'discoveryMode.option.coverageTymhm',
  aoty: 'discoveryMode.option.coverageAoty',
  aotm: 'discoveryMode.option.coverageAotm',
  sitf: 'discoveryMode.option.coverageSitf',
  ymio: 'discoveryMode.option.coverageYmio',
  lit: 'discoveryMode.option.coverageLit',
  contrite: 'discoveryMode.option.coverageContrite',
  rfu: 'discoveryMode.option.coverageRfu',
}

function coverageLabel(slug: string): string {
  return COVERAGE_TYPE_LABELS[slug] ?? slug
}
```

`translateDiscoveryOption` treats a label starting with `discoveryMode.` as a message key and falls back to the raw value, so returning the key directly is the established idiom.

Add to the definition:

```ts
    resolveOptions: async (userId) => {
      const { genres, coverageTypes } = await deps.getFilterOptions(userId)
      const genreOptions = genres.map((g) => ({ value: g, label: genreLabel(g) }))
      return {
        includeGenres: genreOptions,
        excludeGenres: genreOptions,
        coverageTypes: coverageTypes.map((c) => ({ value: c, label: coverageLabel(c) })),
      }
    },
```

Add `getFilterOptions` to the deps type and to `defaultDeps()`, bound to `getMusicRaterFilterOptions(db, userId)`.

- [ ] **Step 5: Add the coverage-type labels to all 15 locales**

In `en.ts`:

```ts
  'discoveryMode.option.coverageReview': 'Review',
  'discoveryMode.option.coverageTymhm': 'Things You Might Have Missed',
  'discoveryMode.option.coverageAoty': 'Album of the Year',
  'discoveryMode.option.coverageAotm': 'Record of the Month',
  'discoveryMode.option.coverageSitf': 'Sophomore in the Foreground',
  'discoveryMode.option.coverageYmio': 'Yer Metal Is Olde',
  'discoveryMode.option.coverageLit': 'Lost in Time',
  'discoveryMode.option.coverageContrite': 'Contrite Metal Guy',
  'discoveryMode.option.coverageRfu': 'Records for Us',
```

> Verify each expansion against music-rater's own naming before translating —
> `src/music_rater/models/enums.py` and `src/music_rater/sources.py` carry the
> editorial descriptions. Do not guess an acronym; if a source does not state
> it, keep the raw slug as the English label and say so in your report.

Then the same keys in the other 14 locales. Several of these are publication
column names — treat them as proper nouns and leave them untranslated where
that is what the neighbouring catalogs do with brand names.

- [ ] **Step 6: Run the tests and gates**

Run: `bun run test tests/db/queries/music-rater.test.ts tests/core/discovery-modes/critically-acclaimed.test.ts`
Then: `bun run typecheck && bun run lint && bun run i18n:check`
Then the full `bun run test`.

- [ ] **Step 7: Commit**

```bash
git add src/db/queries/music-rater.ts src/core/discovery-modes/modes/critically-acclaimed.ts src/core/i18n/ tests/
git commit -m "feat(critically-acclaimed): corpus-derived filter option lists"
```

---

### Task 7: documentation

**Files:**
- Modify: `README.md`, `docs/ARCHITECTURE.md`, `CHANGELOG.md`

- [ ] **Step 1: Document the filters**

README: extend the Critically Acclaimed entry with the new controls. Be accurate about what `includeUnscored` does — it admits editorial picks that carry no rating, which is the only way to reach TYMHM/SITF/YMIO.

`docs/ARCHITECTURE.md`: note `resolveOptions` in the `DiscoveryMode` registry bullet — it is a new extension point other modes can use. Keep the file's dense register.

CHANGELOG: an entry under `## Unreleased` in the repo's user-facing voice. Mention that the corpus now syncs unscored albums, since that is a visible change to the nightly job.

- [ ] **Step 2: Verify and commit**

Run: `bun run test && bun run typecheck && bun run lint && bun run i18n:check`

```bash
git add README.md docs/ARCHITECTURE.md CHANGELOG.md
git commit -m "docs(music-rater): document the genre and coverage-type filters"
```
