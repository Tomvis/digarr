# music-rater as a digarr service

> Status: approved design, not yet implemented
> Date: 2026-09-16
> Branch base: `oidc-private-issuer` @ 50af2ced (merged to upstream v1.17.0)

## Goal

Make music-rater a first-class connected service in digarr, in two roles:

1. **Candidate source** — critically acclaimed albums the user does not own
   become `kind='album'` recommendations.
2. **Score signal** — an album candidate found by any producer is nudged by
   music-rater's critic rating.

## Ruled out: AudioMuse-AI

Considered and dropped. AudioMuse only knows the analysed library, so
`similar_artists` returns artists already in Navidrome. It cannot produce a
candidate digarr does not already have, and a candidate source is the point.
Its genuine strengths (sonic seed selection, mood features, playlist
generation via `/api/alchemy` + `/api/create_playlist`) are real but do not
justify a ~45-file integration today. Revisit only if seed quality becomes the
bottleneck.

## The constraint that shapes everything

music-rater's release-group MBID is backfilled **as a side effect of Lidarr
sync**. Measured against the live database on 2026-09-16:

| | albums |
|---|---|
| total | 14,035 |
| have `musicbrainz_release_group_id` | 2,137 |
| …of those, `lidarr_synced = true` | 2,137 (all) |
| have an MBID but are not owned | **0** |
| not owned — the candidate pool | 11,898 (6,309 from 2020+) |

So every album music-rater can identify by MBID is one the user already owns,
and every album worth recommending has no MBID. The join key digarr needs does
not exist on the rows that matter, and the same gap hits the score signal in
reverse: a Release Radar candidate has an rgid in digarr, but music-rater has
no rgid for an album nobody owns, so `/tags/by-release-group/{rgid}` 404s.

**Decision: digarr resolves names to MBIDs itself**, reusing
`matchSuggestedAlbum` (`src/core/pipeline/resolve.ts:259`) through the
MusicBrainz rate gate. music-rater grows no MusicBrainz dependency and needs no
11,898-row backfill. The cost is that the resolution benefits digarr only —
beets `reviewtags` and Music Assistant still get nothing.

## Architecture

Four components, in dependency order.

```
music-rater                                   digarr
┌──────────────────────┐                     ┌────────────────────────────┐
│ 1. mr_ API keys      │◄───Bearer mr_…──────│ 2. per-user connection     │
│    per user          │                     │    users.musicRaterUrl     │
│                      │                     │         .musicRaterApiKey  │
│ GET /api/v1/albums   │──── ~29 calls ─────►│    music_rater_albums      │
│  (site-scoped)       │      limit=500       │    (synced corpus)         │
└──────────────────────┘                     └─────────┬──────────────────┘
                                                       │
                                      ┌────────────────┴────────────────┐
                                      ▼                                 ▼
                          3. critically-acclaimed          4. criticScore signal
                             DiscoveryMode                    in applyAlbumModifier
```

---

## Component 1 — `mr_` API keys in music-rater

The prerequisite. music-rater has no non-interactive auth: `auth/policy.py:41`
makes `GET /health` the only public route, everything else needs the
`mr_session` OIDC cookie from Redis. There is no bearer path, no API key, and
login requires a browser (`mr_oidcflow` state cookie).

A key belongs to a user, so digarr inherits that user's followed sites and
per-site score thresholds — which is why `/api/v1/albums` returns the right
rows without digarr knowing anything about music-rater's scoring policy.

### Schema

New `api_keys` table matching the house style in `models/orm.py`: plain `int`
identity PK (like `users`/`libraries`, not the `BigInteger` used on the
high-volume tables), no mixins, timestamps via the module-level `_ts_column()`
helper, FK to `users.id` with `ondelete="CASCADE"`, no `Relationship()`.

| column | notes |
|---|---|
| `id` | int identity PK |
| `user_id` | FK `users.id`, CASCADE |
| `token_hash` | Text, unique + index — SHA-256 hex of the token |
| `prefix` | Text, first 8 chars, non-secret display label |
| `name` | Text, user-supplied label |
| `created_at` / `last_used_at` / `revoked_at` | `_ts_column()` |

Migration `alembic/versions/2026_09_16_0048_api_keys.py`, revision
`0048_api_keys`, down-revision `0047_run_library_id` (the current head). Plain
`op.create_table`, following `0045`; the repo guards re-runs with the advisory
lock in `db/bootstrap.py:ensure_database`, not with `IF NOT EXISTS`. The module
docstring must explain *why*, per the convention set by `0045`.

### Token scheme

Constrained by a standing rule against new cryptographic dependencies
(`auth/oidc.py:7`; `orm.py:757-768`) — there is no passlib, bcrypt, argon2 or
`cryptography` in the tree. Build from stdlib:

- Mint `"mr_" + secrets.token_urlsafe(32)`, the same primitive
  `auth/sessions.py:111` uses for session ids.
- Store only `hashlib.sha256(token.encode()).hexdigest()`. A 256-bit random
  token needs no KDF; the slow-hash argument applies to low-entropy passwords.
- Look up by hash (single indexed query) and still finish with
  `secrets.compare_digest` on **bytes**, reusing the idiom and rationale at
  `routers/auth.py:280-291`.

### Auth pipeline

The bearer branch slots into `authorize()` at `policy.py:188-195`, between the
`PUBLIC` short-circuit and `get_session_store`. Three constraints, each pinned
by an existing test:

- `authorize(request)` keeps its parameter-free signature. Declaring
  `Depends(get_session_store)` 503'd every route on a dead Redis with auth off;
  declaring `Depends(get_session)` pinned a DB connection for the life of every
  SSE stream (`policy.py:145-171`).
- The bearer path must **not** touch Redis — the key lives in Postgres. Build
  the session store lazily on the cookie path only, or API-key callers
  re-acquire the Redis hard dependency.
- The `async with session_scope()` block still closes before the 403 check.

Roles are unchanged: a key resolves to its user's row and `classify()` applies
as today (GET→VIEWER, mutations→MEMBER, the 24 `ADMIN_ROUTES`→ADMIN).

### Router

`/me/api-keys`, mirroring `routers/site_prefs.py` — resolved via
`Depends(get_acting_context)`, **no user id in the path**, so there is no route
to anyone else's keys by construction. It goes in the guarded `include_router`
loop at `api/main.py:305-334`, *not* on `auth.py`, which sits outside the loop
and would ship it unauthenticated (`site_prefs.py:1-33` explains this).

Schemas follow the write-only-credential rule stated three times in the repo
(`schemas/auth.py:63-73`, `schemas/users.py:26-34`): `ApiKeyOut` never contains
the secret; the plaintext `mr_…` appears exactly once, in the create response.

### Frontend

`dashboard/src/app/api-keys/page.tsx`, nav entry under **Account** beside Site
Preferences (`components/nav.tsx:78-91` — the nav has no role filtering, so a
personal surface must not be filed under Admin). Closest existing component to
copy is `components/settings/my-ma-token.tsx`, a write-only personal credential
with a set/not-set indicator.

### Test gate

`tests/test_auth_policy.py:138` pins `EXPECTED_ROUTE_COUNT = 101` with `==`.
Every new route fails it until the number is bumped **and** a comment block
explains the jump and the `ADMIN_ROUTES` decision. Do not relax it to `>=`.
Also satisfied: `test_every_route_is_classified`,
`test_every_route_actually_enforces_the_policy_for_anonymous` (its five-entry
exemption set is explicit), `test_viewer_is_denied_every_mutating_route`.

### Side benefit

The beets `reviewtags` plugin
(`beets-lidarr/beetsplug/reviewtags.py:164`) calls
`GET /api/v1/tags/by-release-group/{rgid}` with no credentials and has been
401'ing since auth was switched on. An `mr_` key fixes it.

---

## Component 2 — digarr connection and corpus sync

### Connection

The credential is per-user, so it follows the per-user connection pattern, not
the global `settings` row: `musicRaterUrl` + `musicRaterApiKey` columns on
`users` (`src/db/schema.ts:79-121`), beside `subsonicUrl` and `discogsToken`.

Threads through, in order:

1. `src/db/schema.ts` + a drizzle migration (hand-added `IF NOT EXISTS`, per
   the invariant in `docs/ARCHITECTURE.md:199`)
2. `SENSITIVE_USER_CONNECTIONS` (`src/core/crypto.ts:302-310`) — the API key is
   encrypted at rest
3. the per-user block of `updateSettingsSchema`
   (`src/server/schemas/settings.ts:119-139`)
4. `SECRET_FIELDS` → `maskSecrets()` (`src/server/routes/settings.ts:27-40`)
5. a `case 'music-rater'` in the test switch (`settings.ts:469`), probing
   `GET /api/v1/health` and returning `ServiceTestResult`
6. a `<ServiceCard>` block in `src/web/pages/settings.tsx` plus its ~6 scattered
   state/hook lines, and a `service-icons.tsx` entry
7. `INTEGRATIONS` in `src/web/components/integration-capabilities.tsx:14-105`
8. 15 i18n catalogs; `music-rater` added to `PROTECTED_I18N_TERMS`
   (`src/core/i18n/protected-terms.ts:18`)

Not touched: the setup wizard. music-rater is not a starting point.

### `music_rater_albums`

One row per (user, music-rater album).

| column | notes |
|---|---|
| `userId` | FK `users.id` |
| `musicRaterAlbumId` | music-rater's `albums.id` |
| `artistNameRaw` / `albumTitleRaw` | as music-rater has them |
| `artistNameNormalized` / `albumTitleNormalized` | **digarr's** normalisation, applied to both sides of the score-signal match so digarr's and music-rater's normalisers never have to agree (see below) |
| `releaseYear`, `maxScoreRatio`, `genreSlugs`, `drValue`, `sourceSites` | the signal |
| `resolvedArtistMbid`, `resolvedReleaseGroupMbid`, `resolvedAt` | written back by the mode |

Unique on `(userId, musicRaterAlbumId)`.

As shipped, there is no `ownedInLibrary` column -- ownership is not
denormalised onto this table at all. It's enforced by two separate checks in
`src/db/queries/music-rater.ts`: a pre-resolution best-effort name match
against the user's library (`getUnresolvedAcclaimedAlbums`, screening a row
out before any MusicBrainz call is spent on it) and a post-resolution exact
release-group-MBID check against `library_albums`
(`isReleaseGroupOwnedByUser`), once a row has actually resolved. The name
match can miss a real spelling variant or alias; the MBID check, being exact,
cannot.

### A shared normaliser has to exist first

There is no single "digarr normalisation" to point at today. There are three
private ones, none exported:

- `artistKey` (`src/core/pipeline/genre-backfill.ts:53`) — artist names
- `normalizeTitle` (`src/core/albums/popular.ts:15`) — NFKD, strips diacritics,
  lowercases
- `normalizeTitle` (`src/core/pipeline/resolve.ts:252`) — strips a trailing
  parenthetical, for matching MusicBrainz release-group titles

The first two are the general-purpose matchers this feature needs on both sides
of the join, so the implementation adds a new, exported pair --
`normalizeArtistName` / `normalizeAlbumTitle` in `src/core/matching/normalize.ts`
-- rather than promoting either existing private one in place.

**As shipped, the two existing call sites were deliberately NOT migrated onto
the shared module** -- unlike what this section originally proposed. Both
stayed on their own local normalisers:

- `normalizeTitle` in `albums/popular.ts` stays because it is intentionally
  more aggressive than the shared module needs to be: it folds `&` to `and`
  and strips everything but `[a-z0-9]`, which is correct for its own job
  (Spotify ↔ MusicBrainz title matching) but would be a behaviour change if
  swapped for the conservative shared normaliser.
- `artistKey` in `pipeline/genre-backfill.ts` stays because it keys a
  *persisted* cache table with deliberately no diacritic stripping.
  `normalizeArtistName` strips diacritics; migrating the cache key onto it
  would have silently orphaned every row cached under the old spelling, with
  no way to distinguish "cache miss" from "cache key changed underneath me".

`src/core/matching/normalize.ts`'s own docstring carries the full reasoning
for both; this section restates the outcome, not a substitute for reading it.
The third private normaliser (`resolve.ts`'s `normalizeTitle`) still stays put
for the original, unrelated reason: it solves release-group title
disambiguation, not general matching, and folding it in would silently change
`matchSuggestedAlbum`'s behaviour.

Adding the shared module was still a prerequisite of Component 2; only the
"migrate the two existing call sites onto it" half of this plan was reverted
before shipping.

### Sync

A scheduler entry walking `GET /api/v1/albums?has_score=true&limit=500` with
`offset` paging (~29 calls for 14k rows), upserting on the natural key. Uses
`createHttpClient()` (`src/core/clients/http.ts:46`) for timeout, retry,
redaction — per the invariant that all provider requests do.

Resolution results are never discarded, so each album is resolved against
MusicBrainz exactly once, ever. A sync failure leaves the previous corpus
intact and marks the job failed — the same rule upstream applied to library
sync in v1.17.0.

---

## Component 3 — the `critically-acclaimed` discovery mode

`DiscoveryMode` is digarr's one genuinely registry-shaped extension point, and
the frontend renders mode cards generically, so **there is no frontend work**.

The executor mirrors `modes/gap-fill.ts` closely — bounded slice, rotating
cursor, p-queue — with `resolvedAt` as the cursor instead of
`library_artists.last_gap_check_at`:

```
music_rater_albums
  → filter: not name-matched against the library (pre-resolution, best-effort),
             maxScoreRatio ≥ threshold, releaseYear ≥ N
  → order by resolvedAt asc nulls first, take maxAlbumsPerRun (default 25)
  → artist name → artist MBID           (digarr's artists cache; usually a hit)
  → matchSuggestedAlbum(title, artistMbid, mb)
  → exact release-group-MBID ownership check (post-resolution, definitive)
  → RawDiscoveryCandidate {
      candidateType: 'release',
      artistName, artistMbid, releaseGroupMbid,
      provenanceProvider: 'music-rater',
      freshnessDate: String(releaseYear),
    }
  → stamp resolvedAt
```

`matchSuggestedAlbum` needs an **artist** MBID and matches the title within
that artist's release groups, so resolution is two-stage; the artist stage is
nearly free because digarr already caches artists. An album that fails to
resolve is stamped anyway so the cursor advances and a permanently
unresolvable row cannot wedge the rotation — but `resolvedReleaseGroupMbid`
stays null, and the filter skips rows already resolved.

`freshnessDate` carries the release year exactly as
`coverageToReleaseCandidates` does (`gap-fill.ts:19`), so the album scorer's
recency signal applies.

Wiring, all of it:

- `src/core/discovery-modes/modes/critically-acclaimed.ts`
- one `registry.register(createCriticallyAcclaimedMode())` line
  (`discovery-modes/registry.ts`)
- `hasMusicRater` on `DiscoveryConnectionSnapshot` and
  `EMPTY_DISCOVERY_SNAPSHOT` (`availability.ts:1-24`), populated at
  `src/index.ts:282-286`
- one row in `SINGLE_FLAG_MODES` (`availability.ts:62-98`)
- `discoveryMode.critically-acclaimed.label` / `.description` and a
  `discoveryMode.reason.connectMusicRater` key across 15 catalogs, plus the
  mapping entry in `src/web/lib/discovery-i18n.ts:57`

Config fields: `minScoreRatio` (easy), `minReleaseYear` (easy),
`maxAlbumsPerRun` (advanced).

---

## Component 4 — the `criticScore` album signal

Cheaper than expected. `AlbumScoreSignals` (`src/core/pipeline/score.ts:48-55`)
already has a `popularity` slot documented as "Album popularity / rating", and
`applyAlbumModifier` averages whatever signals are present and scales the
result by `ALBUM_MODIFIER_WEIGHT = 0.15`.

So: add `criticScore?: number` to `AlbumScoreSignals`, populate it from
`music_rater_albums` by normalised-name match during enrichment, and extend the
existing call at `score.ts:172`:

```ts
finalScore = applyAlbumModifier(baseScore, { recency, popularity, criticScore })
```

Record it in `sourceScores` alongside `recency` so it surfaces on the card.

**No new `ScoringWeights` entry, no weights-UI change, no `preferences` jsonb
migration** — the modifier is already bounded and self-normalising. An album
found by Release Radar, gap-fill or the AI that music-rater rates highly is
nudged up within its similarity band; the artist-similarity base stays
dominant by design.

### Deliberately out of scope

Artist-kind candidates get nothing. `applyAlbumModifier` only fires for
`kind === 'album'`, and a critic boost for artists would need a real
`ScoringWeights` entry plus a weights migration. music-rater has artist
dossiers (`/api/v1/artists/{normalized_name}`, with per-source score stats), so
this is a sensible v2 — it simply is not free the way the album path is.

## Error handling

- music-rater unreachable → the sync job fails and is visible in Job History;
  the mode still runs against the last good corpus. This is the main argument
  for syncing rather than calling live.
- `mr_` key revoked → 401 on sync; surface as a connection error on the
  settings card, same as any other service.
- An album that never resolves → stamped, skipped, never retried in a way that
  blocks the cursor.
- MusicBrainz rate-limited → the shared gate and circuit breaker already handle
  it; the mode inherits the behaviour, and a breaker hold means the run
  produces fewer candidates, not an error.

## Testing

Vitest, following the existing integration shape:

- `tests/core/clients/music-rater.test.ts` — client
- `tests/core/discovery-modes/critically-acclaimed.test.ts` — mode, including
  the cursor advancing past an unresolvable album
- `tests/core/discovery-modes/availability.test.ts` — the new flag
- `tests/server/routes/settings.test.ts` — the `test/:service` probe
- `tests/core/pipeline/score.test.ts` — the new signal, and that an absent
  `criticScore` leaves scoring byte-for-byte unchanged

Gates that must stay green: `test`, `typecheck`, `lint`, `i18n:check`,
`check:api-docs`. Note `tests/core/plugins/source-ids.test.ts` fails until a
new source id is registered.

On the music-rater side: pytest, `tests/test_api_api_keys.py` using the
`member_api_client` / `viewer_api_client` / `anonymous_api_client` fixtures in
`tests/conftest.py`, plus the `EXPECTED_ROUTE_COUNT` bump.

## Sequencing

1. **Component 1** — `mr_` keys. Nothing else can run without it, and it
   independently unbreaks beets `reviewtags`.
2. **Component 2 + 3** — connection, corpus sync, discovery mode. This is a
   complete, shippable feature on its own.
3. **Component 4** — the score signal, on a table that already exists.

## Open question for implementation

Corpus rows are per-user because `/api/v1/albums` is server-side scoped to the
caller's followed sites and thresholds. With a household of two or three this
is ~14k rows each and not worth normalising. If digarr ever has many
music-rater users, fetch the corpus once and apply scoping locally from
`/api/v1/sites` + `/api/v1/me/site-preferences`.
