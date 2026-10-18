# Track Recommendations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `track` recommendation kind, fed by ListenBrainz Weekly Jams / Weekly Exploration, approved through the `songpick` service.

**Architecture:** New nullable track columns on `recommendations` (kind `'track'`, `artist_id` = track's artist). Subscription adapters may return `tracks`; the runner stores them on a dedicated path (no artist filters; dedupe by recording MBID; owned-filter via Subsonic). A new `songpick` destination target with capability `addTrack` handles approval for track recs everywhere approval happens.

**Tech Stack:** TypeScript, Bun, Hono, drizzle (Postgres), React, vitest.

**Spec:** `docs/superpowers/specs/2026-10-18-track-recommendations-design.md`

## Global Constraints

- Worktree `/Users/tom/Projects/digarr/.worktrees/music-114`, branch `music-114` off `enhanced`. Never commit to `main`/`develop`.
- Migration is fork-range `0903_track_recommendations`, appended after journal idx 61 (`0054_blue_morbius`); never hand-edit `when`.
- Songpick default URL `http://songpick:9394`; request `POST /song` JSON `{root_folder, artist_name, artist_mbid, track_name, recording_mbid}`; health `GET /health`; approve timeout 15 min.
- Track score = `0.85 - 0.3 * position / length` (position 0-based).
- Status mapping: songpick `wanted`|`already_wanted` → `approved`; `owned` → `duplicate`; any error/no target/no root folder → `add_failed`.
- Every new UI string goes in all 15 locale catalogs (`bun run i18n:check` passes). Every new route row in `docs/API.md` (`bun run check:api-docs`).
- Per-task checks: `bunx vitest run <touched test files>`, `bun run typecheck`, `bun run lint`.
- Existing artist/album behaviour must not change (existing tests stay green).

## Review Focus

1. LB playlist list containing several weeks → only the newest "Weekly Jams for"/"Weekly Exploration for" playlist is used (Task 2 test).
2. JSPF track missing recording identifier or artist MBID → skipped, not stored with nulls (Task 3 test).
3. MA's bare `PATCH {status:'approved'}` on a track rec → songpick called, never Lidarr `addArtist` (Task 5 test).
4. Subsonic lookup throws → track kept, run does not fail (Task 3 test).
5. Hygiene run with an artist rec and a track rec for the same artist → neither marked `duplicate` because of the other (Task 6 test).

---

### Task 1: Schema, migration, kind `'track'` plumbing

**Files:**
- Modify: `src/db/schema.ts` (recommendations table ~267-308)
- Create: `drizzle/0903_track_recommendations.sql`, snapshot + `drizzle/meta/_journal.json` entry
- Modify: `tests/core/ops/upgrade-old-schema.test.ts` (cutoff → 0903)
- Modify: kind unions — `src/core/types.ts` (`ResolvedArtist.kind`), `src/core/pipeline/store.ts:52` (`insertRecommendation` data), `src/db/queries/recommendations.ts` (`InsertRecommendationData` ~488, `listRecommendations` kind filter ~87), `src/server/routes/recommendations.ts:621` (list kind narrowing), `src/server/schemas/recommendations.ts`, `src/server/helpers/openapi-doc.ts:186-188,698-702`, web `Recommendation` type `src/web/components/recommendation-card.tsx:20-44`
- Modify: `docs/API.md` recommendations section (kind values + track fields)
- Test: `tests/db/queries/recommendations-kind-filter.test.ts`, `tests/server/schemas/recommendations.test.ts`

**Interfaces:**
- Produces: columns `recommendedRecordingMbid`, `recommendedTrackTitle`, `recommendedTrackAlbum`, `recommendedCoverReleaseMbid` (all `text`, nullable; snake_case in SQL), index `recommendations_user_recording_idx` on `(user_id, recommended_recording_mbid)`.
- Produces: `export type RecommendationKind = 'artist' | 'album' | 'track'` in `src/core/types.ts`; every kind union above uses it.
- Produces: `insertRecommendation` / `InsertRecommendationData` accept the four new optional fields.

- [ ] **Step 1: Failing tests** — kind-filter test: `listRecommendations({ kind: 'track' })` builds a `kind = 'track'` condition (mirror the existing `'album'` case). Schema test: list query schema accepts `kind=track`, rejects `kind=song`.
- [ ] **Step 2: Run** `bunx vitest run tests/db/queries/recommendations-kind-filter.test.ts tests/server/schemas/recommendations.test.ts` → FAIL.
- [ ] **Step 3: Implement** schema columns + index, `RecommendationKind`, union/zod/OpenAPI changes.
- [ ] **Step 4: Migration** — `bunx drizzle-kit generate`, `git mv` the new file to `drizzle/0903_track_recommendations.sql`, set only that journal entry's `tag`; re-run generate → "No schema changes". Bump upgrade-test cutoff to `0903`.
- [ ] **Step 5: Run** the two tests + `tests/core/ops/upgrade-old-schema.test.ts` + typecheck → PASS.
- [ ] **Step 6: Commit** `feat(recs): track kind columns + migration 0903 (MUSIC-114)`.

### Task 2: ListenBrainz Weekly Jams fix + Weekly Exploration (track output)

**Files:**
- Modify: `src/core/subscriptions/types.ts` (`AdapterResult`), `src/core/types.ts` (`DiscoveredTrack`)
- Modify: `src/core/subscriptions/adapters/listenbrainz.ts` (`CONFIG_FIELDS` feedType options, `fetch` dispatch, replace `fetchWeeklyJams`)
- Test: `tests/core/subscriptions/adapters/listenbrainz.test.ts`

**Interfaces:**
- Produces in `src/core/types.ts`:
  `export type DiscoveredTrack = { artistName: string; artistMbid?: string; title: string; recordingMbid?: string; album?: string; coverReleaseMbid?: string; position: number; total: number; source: string }`
- Produces: `AdapterResult = { artists: DiscoveredArtist[]; tracks?: DiscoveredTrack[] }`.
- Produces: `fetchLbCreatedForPlaylist(username: string, token: string, titlePrefix: 'Weekly Jams for' | 'Weekly Exploration for', source: string): Promise<AdapterResult>` — returns `{ artists: [], tracks }`.

- [ ] **Step 1: Failing tests** (mock `fetch`):
  - `weekly-jams` calls `GET /1/user/tomvis/playlists/createdfor`, then `GET /1/playlist/<mbid of newest Weekly Jams>`; with two Weekly Jams entries (`date` 2026-09-28 and 2026-10-05, newest listed second) it fetches the 2026-10-05 one.
  - A JSPF track `{creator:'Haken', title:'Sempiternal Beings', album:'Fauna', identifier:['https://musicbrainz.org/recording/06ee307a-4d83-4d5d-8cb8-64e379346d8c'], extension:{'https://musicbrainz.org/doc/jspf#track':{additional_metadata:{artists:[{artist_mbid:'0246a3fd-a254-416d-8cd2-e31da4ac6f59'}], caa_release_mbid:'d7fae1b8-fdfb-4c26-b230-6a3dd7b68d6d'}}}}` maps to `{artistName:'Haken', artistMbid:'0246a3fd-…', title:'Sempiternal Beings', recordingMbid:'06ee307a-…', album:'Fauna', coverReleaseMbid:'d7fae1b8-…', position:0, total:N, source:'listenbrainz:weekly-jams'}`.
  - `weekly-exploration` picks the "Weekly Exploration for" playlist, source `listenbrainz:weekly-exploration`.
  - No matching playlist → `{ artists: [], tracks: [] }`; non-OK list response → throws `ListenBrainz weekly-jams fetch failed: <status>`.
- [ ] **Step 2: Run** `bunx vitest run tests/core/subscriptions/adapters/listenbrainz.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Newest = max of `playlist.date` (fallback: list order). Both requests send `Authorization: Token <token>` with the existing 10 s abort. Add `{ value: 'weekly-exploration', label: 'Weekly Exploration' }` to feedType options (and its i18n key if feed labels are translated — follow how `weekly-jams` is labelled in the web subscription form).
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `fix(lb): weekly-jams reads createdfor playlists; add weekly-exploration; emit tracks (MUSIC-114)`.

### Task 3: Runner track path (dedupe, owned filter, store)

**Files:**
- Create: `src/core/subscriptions/tracks.ts`
- Modify: `src/core/subscriptions/runner.ts` (after `adapter.fetch`), `src/core/subscriptions/types.ts` (`SubscriptionRunDeps`)
- Modify: `src/db/queries/recommendations.ts` (new query), `src/index.ts` (wire deps ~1100-1130)
- Test: `tests/core/subscriptions/tracks.test.ts`, `tests/core/subscriptions/runner.test.ts`

**Interfaces:**
- Consumes: `DiscoveredTrack`, `AdapterResult.tracks` (Task 2); `insertRecommendation` fields (Task 1).
- Produces in `SubscriptionRunDeps`:
  `getRecommendedRecordingMbids?: (userId: number | null) => Promise<Set<string>>` and
  `isTrackOwned?: (artistName: string, title: string) => Promise<boolean>`.
- Produces in `src/db/queries/recommendations.ts`: `getRecommendedRecordingMbids(db, userId: number | null): Promise<Set<string>>` (all statuses, `kind='track'`, user-scoped; `null` → `user_id IS NULL`).
- Produces in `tracks.ts`:
  `selectTracks(tracks: DiscoveredTrack[], opts: { known: Set<string>; isOwned?: (a: string, t: string) => Promise<boolean>; threshold: number; cap?: number }): Promise<Array<DiscoveredTrack & { score: number }>>` and
  `storeTracks(tracks: Array<DiscoveredTrack & { score: number }>, db: StoreDb, mb: MusicBrainzClient, options: StoreOptions): Promise<{ batchId: number; added: number }>`.

- [ ] **Step 1: Failing tests** (`tracks.test.ts`):
  - drops tracks without `recordingMbid` or `artistMbid`;
  - dedupes within the list by `recordingMbid` (first wins) and drops those in `known`;
  - drops owned (`isOwned` → true); `isOwned` throwing → track kept;
  - score for position 0 of 50 = 0.85, position 25 of 50 = 0.70; tracks below `threshold` dropped; `cap` keeps the top-N by score;
  - `storeTracks` upserts the artist once per artist MBID (via `mb.lookupArtist`) and calls `insertRecommendation` with `kind:'track'`, `recommendedRecordingMbid`, `recommendedTrackTitle`, `recommendedTrackAlbum`, `recommendedCoverReleaseMbid`, `sources: { [source]: score }`, `status:'pending'`, `userId`; an artist lookup failure skips only that track.
  - `runner.test.ts`: adapter returning `{ artists: [], tracks:[…] }` stores tracks, never calls `filter`/`resolve`, records `metadata.tracksFound/tracksNew` and `lastResultCount = tracksNew`.
- [ ] **Step 2: Run** `bunx vitest run tests/core/subscriptions/tracks.test.ts tests/core/subscriptions/runner.test.ts` → FAIL.
- [ ] **Step 3: Implement** `tracks.ts`; runner branches when `tracks?.length` (artists path unchanged when `artists.length`). Batch via `db.insertBatch`/`completeBatch` like `store()`; reuse the artist-row fields `store()` builds (resolve image/genres through existing artist upsert; minimal `{mbid, name}` + MB data is acceptable).
- [ ] **Step 4: Wire `src/index.ts`**: `getRecommendedRecordingMbids` from the query; `isTrackOwned` only when the subscription user has a Subsonic connection — `createSubsonicClient(url, user, pass, { musicFolderId })`, `searchTracks(artistName, 100)` cached per normalized artist within the run, match `normalizeArtistName(artist)` and `normalizeAlbumTitle(title)` (from `src/core/matching/normalize.ts`) both equal.
- [ ] **Step 5: Run** tests + typecheck → PASS. **Step 6: Commit** `feat(subscriptions): store track recs with owned/known filtering (MUSIC-114)`.

### Task 4: Songpick client + target

**Files:**
- Create: `src/core/clients/songpick.ts`, `src/core/targets/songpick.ts`
- Modify: `src/core/targets/types.ts` (capability, type, interface), `src/core/targets/registry.ts`, `src/core/targets/test-connection.ts`, `src/server/schemas/targets.ts`, `src/index.ts` (`getEnabledTargetsForResolvedUser`), targets settings UI (where `slskd` target form fields are defined), i18n catalogs, `docs/API.md` targets section
- Test: `tests/core/clients/songpick.test.ts`, `tests/core/targets/songpick.test.ts`, `tests/core/targets/test-connection.test.ts`

**Interfaces:**
- Produces: `TargetCapability` adds `'addTrack'`; `TARGET_TYPES` adds `'songpick'`.
- Produces on `DestinationTarget`: `addTrack?(track: { artistMbid: string; artistName: string; title: string; recordingMbid?: string }, options?: TargetAddOptions): Promise<TrackTargetResult>` with
  `export type TrackTargetResult = TargetResult & { songpickStatus?: 'owned' | 'already_wanted' | 'wanted'; albumName?: string; edition?: string }`.
- Produces: `createSongpickClient(url: string, opts?: { timeoutMs?: number; fetch?: typeof fetch }): { want(req: SongpickRequest): Promise<SongpickResponse>; health(): Promise<ServiceTestResult> }`; non-2xx throws `SongpickError(status, message)` with the body's `error`.
- Produces: `createSongpickTarget(id: number, cfg: { url: string; resolveRootFolderPath: (rootFolderId?: number) => Promise<string | undefined>; timeoutMs?: number }): DestinationTarget` (id string `songpick-<id>`, capabilities `['addTrack']`). Missing root path → `{ success:false, error:'No Lidarr root folder configured for this user' }`.

- [ ] **Step 1: Failing tests**: client posts exactly `{root_folder, artist_name, artist_mbid, track_name, recording_mbid}` to `<url>/song`, parses 200 body, throws `SongpickError(422, '<error>')` on 422, aborts after `timeoutMs`; target maps `wanted` → `{success:true, songpickStatus:'wanted', albumName, edition}`, `SongpickError` → `{success:false, error}`, uses `options.rootFolderId` before its default; test-connection for type `songpick` hits `/health`.
- [ ] **Step 2: Run** the three test files → FAIL.
- [ ] **Step 3: Implement**; default timeout `15 * 60_000`.
- [ ] **Step 4: Wire** `index.ts`: for `row.type === 'songpick'`, `resolveRootFolderPath` = first enabled lidarr target row of this user → `createLidarrClient(...).getRootFolders()` → path of `rootFolderId ?? prefs.rootFolderId` (user prefs via `resolveUserPreferences`, not global `prefs`). Target form: one `url` field, placeholder `http://songpick:9394`. i18n for type label + field label in 15 locales; API.md target type row.
- [ ] **Step 5: Run** tests + typecheck + `bun run i18n:check` + `bun run check:api-docs` → PASS. **Step 6: Commit** `feat(targets): songpick target with addTrack (MUSIC-114)`.

### Task 5: Approval dispatch for track recs

**Files:**
- Modify: `src/server/routes/recommendations.ts` (new `approveTrackToTargets`; PATCH dispatch ~795-845; targetId check ~741; bulk ~894-999; reject path → no artist block for tracks; `removeLidarrArtist` ignored for tracks), `src/core/pipeline/auto-approve.ts`
- Test: `tests/server/routes/recommendations-targets.test.ts`, `tests/api-routes/recommendations.test.ts`, `tests/core/pipeline/auto-approve.test.ts`

**Interfaces:**
- Consumes: `addTrack` / `TrackTargetResult` (Task 4); rec track columns (Task 1).
- Produces: `approveTrackToTargets(track: { artistMbid: string; artistName: string; title: string; recordingMbid?: string }, targets, addOptions, jobRecorder?, userId?, recommendationId?): Promise<ApproveResult>`.

- [ ] **Step 1: Failing tests**:
  - PATCH `{status:'approved'}` on a track rec with lidarr + songpick targets → only songpick `addTrack` called with `{artistMbid, artistName, title: recommendedTrackTitle, recordingMbid}`; lidarr `addArtist` not called; status `approved`; `targetActions['songpick-1']` has `{success:true, songpickStatus:'wanted'}`.
  - songpick `owned` → status `duplicate`; songpick error → `add_failed` and `lidarrError` = error text; no `addTrack` target → `add_failed`, `targetActions` empty.
  - explicit `targetId` of a songpick target on a track rec accepted; on an artist rec → 400 "Target does not support artist approval".
  - bulk approve with a track and an artist rec → each dispatched to its own capability.
  - permanent reject of a track rec creates no `artist_blocks` row.
  - auto-approve skips nothing new: a track rec above threshold goes through `approveTrackToTargets`.
- [ ] **Step 2: Run** the three files → FAIL.
- [ ] **Step 3: Implement**. Track recs skip `buildAddOptions` album/monitor resolution and the SkyHook pre-warm; pass only `rootFolderId` override. Use `result.status` directly for track recs (no `deriveStatusFromActions`). Bulk: process track recs sequentially.
- [ ] **Step 4: Run** → PASS (plus existing `tests/server/routes/recommendations.test.ts`, `recommendations-unapprove.test.ts`). **Step 5: Commit** `feat(recs): approve track recs via songpick (MUSIC-114)`.

### Task 6: Plug kind leaks (hygiene, playlists, exports)

**Files:**
- Modify: `src/core/ops/hygiene.ts:35-80,163`, `src/core/playlists/strategy-deps.ts`, `src/core/targets/types.ts` (`ExportableRecommendation` + `trackTitle?`, `trackAlbum?`) and export builders that fill it
- Test: hygiene tests (`tests/core/ops/hygiene*.test.ts`), `tests/core/playlists/strategy-deps*.test.ts` (create if absent)

- [ ] **Step 1: Failing tests**: hygiene dedupe with artist rec + track rec (same user/artist) marks neither duplicate; two artist recs still dedupe as before. Playlist strategy deps exclude `kind='track'` rows. Export of a track rec carries `trackTitle`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (hygiene dedupe restricted to `kind='artist'`). **Step 4: Run** → PASS. **Step 5: Commit** `fix(recs): keep track recs out of hygiene dedupe and playlist strategies (MUSIC-114)`.

### Task 7: Web UI

**Files:**
- Modify: `src/web/pages/discover.tsx` (`KindFilter` + empty state), `src/web/components/recommendation-card.tsx` (~734-764), `swipe-card.tsx`, `card-stack.tsx`, `todays-pick.tsx`, `approve-dialog.tsx` (tracks: root folder only), `target-utils.tsx` (`targetActionLabel` for songpick; approve-ability for track recs), `src/web/components/bottom-nav.tsx` (optional Songs entry only if Albums has one — keep parity), i18n catalogs
- Test: `tests/web/components/recommendation-card.test.tsx`

- [ ] **Step 1: Failing tests**: a `kind:'track'` rec renders the "Song" badge, track title as heading, "Haken · Fauna" subtitle, cover `https://coverartarchive.org/release/d7fae1b8-…/front-250`; falls back to `artist.imageUrl` when `recommendedCoverReleaseMbid` is null; no "Start with" line.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; `KindFilter` adds `track` (`?kind=track`). Keys: `recommendation.trackBadge`, `discover.kind.track`, empty-state copy, songpick action label ("Wanted in Lidarr") — all 15 locales. **Step 4: Run** test + `bun run i18n:check` + typecheck → PASS. **Step 5: Commit** `feat(web): render and filter song recommendations (MUSIC-114)`.

### Task 8: Docs contracts + full suite

- [ ] **Step 1:** `bun run check:docs` and `bunx tsx scripts/check-docs-impact.ts --base origin/enhanced`; accept each flagged domain with `--accept <domain> --docs docs/API.md --note "MUSIC-114 track recommendations" --breaking no` (+ `--migration drizzle/0903_track_recommendations.sql` for the schema domain). Commit `docs(contracts): accept MUSIC-114 changes`.
- [ ] **Step 2:** Full suite on .120: ship tree (`COPYFILE_DISABLE=1 tar --no-xattrs`) and run `/opt/forksync/scripts/digarr-checks.sh` wrapped in `burst`; failures must match `forks/baselines/digarr-vitest.txt` only.

### Task 9: Music Assistant skips track recs

**Files:** `~/Projects/music-assistant/server/music_assistant/providers/digarr/__init__.py` (or `parsers.py` — wherever items are mapped), its tests.

- [ ] **Step 1: Failing test**: items with `kind == 'track'` are excluded from `get_recommendations` and `get_recommendation_items`; artist/album items unchanged.
- [ ] **Step 2: Run** provider tests → FAIL. **Step 3: Implement** filter. **Step 4: Run** → PASS. **Step 5: Commit** on MA `enhanced` worktree `fix(digarr): skip track recommendations until rendered (MUSIC-114)`.
