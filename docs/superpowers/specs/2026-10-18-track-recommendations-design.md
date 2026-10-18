# Track recommendations (MUSIC-114) — design

Fork-only (Tomvis/digarr `enhanced`). Tom opted out of the design Q&A; every
choice below is the builder's call unless marked **Tom**.

## Intent

digarr recommends artists and albums. Some recommendations are really songs:
ListenBrainz's "Weekly Jams" / "Weekly Exploration" are lists of recordings,
mostly by artists already in the library, so the artist-level pipeline throws
them away (Tom's `weekly-jams` subscription has stored 0 rows, ever). Approving
a song should want **just that song**, in the same edition MA's "Add to Lidarr"
picks (**Tom**, MUSIC-115) — i.e. hand off to the `songpick` service.

## Goals

1. New recommendation kind `track`, stored in `recommendations`.
2. ListenBrainz `weekly-jams` and new `weekly-exploration` feeds produce track recs.
3. Approving a track rec (UI, bulk, MA's bare PATCH, auto-approve) calls songpick.
4. The web UI lists, filters and renders track recs distinctly.
5. Music Assistant keeps working: track recs must not appear as bogus artist cards.

## Non-goals

- Track recs from AI discover, Spotify/Deezer playlists, tag radio (later; the
  adapter contract added here makes them a small follow-up).
- Rendering track recs in MA's Discover row (follow-up issue).
- Upstreaming. No change to songpick itself.

## Anti-goals

- Approving a track adds the whole artist / album to Lidarr.
- Track recs for songs already owned flood the list (Weekly Jams is mostly
  known artists).
- Existing artist/album behaviour changes (hygiene marking album/track rows
  `duplicate`, MA approval of artist recs, etc.).

## Current state (facts)

- `recommendations.kind` text default `'artist'`; `'album'` uses
  `recommended_release_group_id/_title`. `artist_id` NOT NULL.
- Every source funnels through `store()` (`src/core/pipeline/store.ts`).
  Subscriptions: `AdapterResult = { artists }` → `runner.ts` resolve/score/filter/store.
- `fetchWeeklyJams` (`subscriptions/adapters/listenbrainz.ts`) calls
  `GET /1/user/{u}/playlists` — playlists the user *created* (0 for Tom). The
  right list is `/1/user/{u}/playlists/createdfor`, and list entries carry no
  tracks: each needs `GET /1/playlist/{mbid}`. A track there has `creator`,
  `title`, `album`, `identifier[0]` = recording URL, and
  `extension["https://musicbrainz.org/doc/jspf#track"].additional_metadata`
  with `artists[].artist_mbid` and `caa_release_mbid`. Titles are
  "Weekly Jams for tomvis, week of …" / "Weekly Exploration for …"; several
  weeks can be listed — take the newest of each.
- songpick: `POST http://songpick:9394/song` JSON
  `{root_folder (path), artist_name, track_name, artist_mbid?, recording_mbid?, isrc?, album_rg_mbid?}`.
  200 → `{status: owned|already_wanted|wanted, reason, album_name, release_mbid, dr, edition, artist_added, …}`;
  4xx/5xx → `{error}` (422 = ambiguous/unresolvable, 409 = library conflict).
  Can take ~minutes (Lidarr refresh). digarr shares compose network `internal`
  with songpick, so `http://songpick:9394` resolves.
- Per-user Lidarr root folder is an **id** (`preferences.rootFolderId`, Tom 2,
  Lera 3); songpick needs the **path** — resolve via Lidarr `GET /api/v1/rootfolder`.
- MA (`providers/digarr`) lists `status=pending` with no `kind` filter, resolves
  every item as an artist, approves with bare `PATCH {status:"approved"}`.

## Design

### Data (migration `0903_track_recommendations`)

Add nullable columns to `recommendations`:
`recommended_recording_mbid text`, `recommended_track_title text`,
`recommended_track_album text`, `recommended_cover_release_mbid text`.
Index `(user_id, recommended_recording_mbid)`. `kind` gains `'track'`
(TS unions, zod, OpenAPI enum). `artist_id` stays NOT NULL = the track's
(first credited) artist, upserted through the existing artist resolve path.
Follow the fork migration procedure (generate → rename to `0903_*` → fix the
journal tag; append after idx 61; bump the upgrade-test cutoff to 0903).

### Source: ListenBrainz feeds

- Fix `weekly-jams` (createdfor + per-playlist fetch, newest matching title).
- Add `weekly-exploration` feed (same code, other title prefix), selectable in
  the subscription config UI like the other `feedType`s.
- `AdapterResult` gains optional `tracks: DiscoveredTrack[]`
  (`{artistName, artistMbid?, title, recordingMbid?, album?, coverReleaseMbid?, position, source}`).
  Both feeds return tracks (and no artists) — the old artist output was never
  produced in practice.
- Runner, for tracks: drop entries missing artist MBID or recording MBID;
  dedupe within the run by recording MBID; skip recordings already recommended
  to this user in any status (rejected rows act as the block list); skip owned
  (below); resolve the artist row by MBID (reuse resolve/upsert); score =
  `0.85 − 0.3·position/len` (playlist order is LB's ranking); apply the
  subscription's `scoreThreshold` and `maxArtistsPerRun` (as the cap on
  stored tracks); store via `store()` / `insertRecommendation` with
  `kind:'track'`, sources `[{source:'listenbrainz:weekly-jams'|…}]`.
  **No** artist-existence / library / cooldown filters — known artists are the
  point.
- Owned filter: if the user has a Subsonic/Navidrome connection, `search3`
  (`"<artist> <title>"`, scoped to the user's `subsonic_music_folder_id`) and
  skip on a normalized artist+title match. No connection or lookup error →
  keep the track (songpick still reports `owned` at approve time). Cache
  per-artist results within a run.

### Approval: songpick target

- New target type `songpick`, capability `addTrack`, config `{url}` (default
  `http://songpick:9394`), connection test = `GET /health`. Added to
  `TARGET_TYPES`, targets UI form, test-connection, i18n.
- Dispatch: `kind==='track'` → `approveTrackToTargets` over enabled targets
  with `addTrack` (single PATCH, bulk, explicit `targetId`, auto-approve).
  Explicit-`targetId` and bulk capability checks accept `addTrack` for track recs.
  No `addTrack` target → `add_failed` with a clear error (not a silent artist add).
- Root folder: approve-dialog override, else the user's resolved
  `preferences.rootFolderId`, mapped to a path through the user's enabled
  Lidarr target client `getRootFolders()`; missing → `add_failed`.
- Request: `{root_folder, artist_name, artist_mbid, track_name, recording_mbid}`.
  Timeout 15 min (songpick waits on Lidarr refresh; MA uses 10 min — digarr's
  PATCH is a user-facing request, so the bulk path processes tracks sequentially).
- Result → `targetActions[songpickTargetId] = {status, reason, album, edition, error?}`;
  rec status: `wanted|already_wanted` → `approved`; `owned` → `duplicate`;
  error → `add_failed` with `lidarrError` = songpick's error text.
- `removeLidarrArtist` is ignored for track recs: reverting just flips status
  back to `pending` and does not undo songpick's Lidarr changes (it may have
  added the artist unmonitored and wanted one track — harmless to leave).
- Permanent reject of a track rec does **not** create an artist block.

### Web UI

- `KindFilter`: add `track` ("Songs"); `?kind=track`.
- `recommendation-card`: kind `track` → "Song" badge, title = track title,
  subtitle = artist · album, cover = CAA `release/{coverReleaseMbid}/front-250`
  falling back to the artist image; no album picker / monitoring options in the
  approve dialog for tracks (root folder only).
- Swipe card / card stack / today's pick: show track title + artist for track recs.
- Status label for `approved` track rec: "Wanted in Lidarr".

### Leaks to plug

- Hygiene dedupe (`ops/hygiene.ts`) groups by `(user, artist)` ignoring kind:
  restrict it to `kind='artist'` rows. Rescore: skip non-artist/album kinds
  explicitly (no change in effect).
- `listRecommendations` / route kind narrowing: accept `track`.
- Playlist strategies (`playlists/strategy-deps.ts`): exclude `kind='track'`.
- Exports: include the track columns.
- MA provider (`music-assistant` fork, `providers/digarr`): skip items with
  `kind=='track'` in `get_recommendations`/`get_recommendation_items` until
  the follow-up renders them.

### Docs / checks

`docs/API.md` (kind values, track fields, songpick target), OpenAPI enum,
15-locale i18n for every new key, `check-docs-impact --accept` with
`--migration`, targeted vitest suites + `/opt/forksync/scripts/digarr-checks.sh`.

## Rollout

1. pg_dump digarr (`/mnt/Fast/backups/postgres/digarr-music114-*.dump`).
2. Push `enhanced`; forksync builds/deploys (then MA fork for the skip).
3. Create the songpick target (enabled) in digarr for Tom and Lera; add a
   `weekly-exploration` subscription for Tom (and Lera — she has one playlist).
4. Run Tom's weekly-jams subscription now; verify track rows, owned filter,
   approve one in the UI → songpick log shows the request, Lidarr wants the
   track; verify MA Discover row unchanged.

## Left to the builder

Exact component structure, query shapes, the normalization function (reuse
existing `core/text` / `matching` helpers), i18n wording.
