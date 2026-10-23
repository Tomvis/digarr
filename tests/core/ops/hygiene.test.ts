// @vitest-environment node
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { describe, expect, it, vi } from 'vitest'
import {
  aiReasoningAudit,
  clearImageFailures,
  dedupeRepair,
  getAiAuditStatus,
  purgeSessions,
  rebuildGenres,
  rescoreRecommendations,
  retireOwnedRecommendations,
} from '@/core/ops/hygiene'
import type { Database } from '@/db'
import { getGenreEnrichments } from '@/db/queries/artists'
import { artists, recommendationBatches, recommendations, users } from '@/db/schema'
import { makeTestDb } from '../../helpers/test-db'

vi.setConfig({ testTimeout: 30_000 })

function makeUpdateDb(rowCount: number) {
  return {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue({ rowCount }),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue({ rowCount }),
    }),
  }
}

describe('clearImageFailures', () => {
  it('resets imageFailedAt on all artists', async () => {
    const db = makeUpdateDb(42)
    const result = await clearImageFailures(db as never)
    expect(result).toEqual({ tool: 'clear-image-failures', cleared: 42 })
  })
})

describe('purgeSessions', () => {
  it('deletes expired sessions', async () => {
    const db = makeUpdateDb(89)
    const result = await purgeSessions(db as never)
    expect(result).toEqual({ tool: 'purge-sessions', purged: 89 })
  })
})

describe('dedupeRepair', () => {
  async function fixture() {
    const client = new PGlite()
    await client.exec(`CREATE TABLE recommendations (
      id integer PRIMARY KEY, user_id integer, artist_id integer NOT NULL, score real,
      status text, kind text, recommended_release_group_id text, recommended_recording_mbid text
    )`)
    const db = drizzle(client)
    async function insert(
      id: number,
      row: {
        artistId?: number
        score: number
        status?: string
        kind?: string
        rg?: string
        recording?: string
      },
    ) {
      await client.query('INSERT INTO recommendations VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [
        id,
        1,
        row.artistId ?? 10,
        row.score,
        row.status ?? 'pending',
        row.kind ?? 'artist',
        row.rg ?? null,
        row.recording ?? null,
      ])
    }
    async function statuses() {
      const rows = await client.query<{ id: number; status: string }>(
        'SELECT id, status FROM recommendations ORDER BY id',
      )
      return Object.fromEntries(rows.rows.map((row) => [row.id, row.status]))
    }
    return { client, db, insert, statuses }
  }

  it('keeps the best pending rec per artist, kind and release group', async () => {
    const { client, db, insert, statuses } = await fixture()
    try {
      await insert(1, { score: 0.5 })
      await insert(2, { score: 0.9 })
      await insert(3, { score: 0.7, kind: 'album', rg: 'rg-a' })
      await insert(4, { score: 0.6, kind: 'album', rg: 'rg-b' })
      await insert(5, { score: 0.4, kind: 'album', rg: 'rg-b' })

      const result = await dedupeRepair(db as never)

      expect(result).toEqual({ tool: 'dedupe', duplicateGroups: 2, removed: 2 })
      expect(await statuses()).toEqual({
        1: 'duplicate',
        2: 'pending',
        3: 'pending',
        4: 'pending',
        5: 'duplicate',
      })
    } finally {
      await client.close()
    }
  })

  it('keeps track recs for different recordings by one artist', async () => {
    const { client, db, insert, statuses } = await fixture()
    try {
      await insert(1, { score: 0.9, kind: 'track', recording: 'rec-a' })
      await insert(2, { score: 0.8, kind: 'track', recording: 'rec-b' })
      await insert(3, { score: 0.7, kind: 'track', recording: 'rec-b' })

      expect(await dedupeRepair(db as never)).toMatchObject({ duplicateGroups: 1, removed: 1 })
      expect(await statuses()).toEqual({ 1: 'pending', 2: 'pending', 3: 'duplicate' })
    } finally {
      await client.close()
    }
  })

  it('never marks acted-on recommendations as duplicates', async () => {
    const { client, db, insert, statuses } = await fixture()
    try {
      await insert(1, { score: 0.2, status: 'approved' })
      await insert(2, { score: 0.1, status: 'rejected' })
      await insert(3, { score: 0.9 })

      expect(await dedupeRepair(db as never)).toMatchObject({ removed: 0 })
      expect(await statuses()).toEqual({ 1: 'approved', 2: 'rejected', 3: 'pending' })
    } finally {
      await client.close()
    }
  })
})

describe('retireOwnedRecommendations', () => {
  const OWNED = '00000000-0000-4000-8000-000000000001'
  const OTHER = '00000000-0000-4000-8000-000000000002'
  const RG_OWNED = '00000000-0000-4000-8000-0000000000a1'
  const RG_OTHER = '00000000-0000-4000-8000-0000000000a2'

  async function fixture() {
    const client = new PGlite()
    await client.exec(`
      CREATE TABLE artists (id integer PRIMARY KEY, mbid uuid NOT NULL);
      CREATE TABLE library_artists (user_id integer, mbid uuid);
      CREATE TABLE library_albums (user_id integer, album_mbid uuid);
      CREATE TABLE recommendations (
        id integer PRIMARY KEY, user_id integer, artist_id integer NOT NULL,
        status text, kind text, recommended_release_group_id text
      );
      INSERT INTO artists VALUES (1, '${OWNED}'), (2, '${OTHER}');
    `)
    const db = drizzle(client)
    async function rec(
      id: number,
      row: { userId?: number; artistId: number; kind?: string; status?: string; rg?: string },
    ) {
      await client.query('INSERT INTO recommendations VALUES ($1,$2,$3,$4,$5,$6)', [
        id,
        row.userId ?? 1,
        row.artistId,
        row.status ?? 'pending',
        row.kind ?? 'artist',
        row.rg ?? null,
      ])
    }
    async function statuses() {
      const rows = await client.query<{ id: number; status: string }>(
        'SELECT id, status FROM recommendations ORDER BY id',
      )
      return Object.fromEntries(rows.rows.map((row) => [row.id, row.status]))
    }
    return { client, db, rec, statuses }
  }

  it('retires pending artist and album recs the user now owns', async () => {
    const { client, db, rec, statuses } = await fixture()
    try {
      await client.exec(`INSERT INTO library_artists VALUES (NULL, '${OWNED}');
        INSERT INTO library_albums VALUES (1, '${RG_OWNED}')`)
      await rec(1, { artistId: 1 })
      await rec(2, { artistId: 2 })
      await rec(3, { artistId: 2, kind: 'album', rg: RG_OWNED })
      await rec(4, { artistId: 1, kind: 'album', rg: RG_OTHER })
      await rec(5, { artistId: 1, kind: 'track' })

      const result = await retireOwnedRecommendations(db as never)

      expect(result).toEqual({ tool: 'retire-owned', artists: 1, albums: 1 })
      expect(await statuses()).toEqual({
        1: 'in_library',
        2: 'pending',
        3: 'in_library',
        4: 'pending',
        5: 'pending',
      })
    } finally {
      await client.close()
    }
  })

  it("ignores another user's library and acted-on recs", async () => {
    const { client, db, rec, statuses } = await fixture()
    try {
      await client.exec(`INSERT INTO library_artists VALUES (2, '${OWNED}');
        INSERT INTO library_albums VALUES (2, '${RG_OWNED}')`)
      await rec(1, { artistId: 1 })
      await rec(2, { artistId: 2, kind: 'album', rg: RG_OWNED })
      await rec(3, { artistId: 1, userId: 2, status: 'rejected' })
      await rec(4, { artistId: 1, userId: 2 })

      expect(await retireOwnedRecommendations(db as never)).toEqual({
        tool: 'retire-owned',
        artists: 1,
        albums: 0,
      })
      expect(await statuses()).toEqual({
        1: 'pending',
        2: 'pending',
        3: 'rejected',
        4: 'in_library',
      })
    } finally {
      await client.close()
    }
  })
})

describe('dedupeRepair kind scoping', () => {
  it('leaves track and album recs alone but still dedupes artist recs', async () => {
    const { db, close } = await makeTestDb()
    try {
      const d = db as unknown as Database
      const [user] = await d.insert(users).values({ username: 'u', passwordHash: 'h' }).returning()
      const [artist] = await d
        .insert(artists)
        .values({ name: 'A', mbid: '00000000-0000-0000-0000-000000000021' })
        .returning()
      const [batch] = await d.insert(recommendationBatches).values({}).returning()
      if (!user || !artist || !batch) throw new Error('fixture')
      const base = { userId: user.id, batchId: batch.id, artistId: artist.id }
      await d.insert(recommendations).values([
        { ...base, kind: 'artist', score: 0.9 },
        { ...base, kind: 'track', score: 0.8 },
        { ...base, kind: 'album', score: 0.7 },
      ])
      const first = await dedupeRepair(d as never)
      expect(first).toMatchObject({ duplicateGroups: 0, removed: 0 })
      await d.insert(recommendations).values({ ...base, kind: 'artist', score: 0.5 })
      const second = await dedupeRepair(d as never)
      expect(second).toMatchObject({ duplicateGroups: 1, removed: 1 })
      const rows = await d.select().from(recommendations)
      const dup = rows.filter((r) => r.status === 'duplicate')
      expect(dup).toHaveLength(1)
      expect(dup[0]?.kind).toBe('artist')
      expect(dup[0]?.score).toBe(0.5)
    } finally {
      await close()
    }
  })
})

describe('rebuildGenres', () => {
  async function fixture() {
    const client = new PGlite()
    await client.exec(`
      CREATE TABLE artists (id serial PRIMARY KEY, name text, tags text[], genres text[]);
      CREATE TABLE artist_metadata (id serial PRIMARY KEY, spotify_genres text[]);
      CREATE TABLE genres (
        id integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY, name text NOT NULL,
        slug text NOT NULL UNIQUE, source text NOT NULL, parent_genre_id integer,
        artist_count integer DEFAULT 0, cached_at timestamptz
      );
      INSERT INTO genres (name, slug, source, artist_count) VALUES ('old', 'old', 'library', 1);
    `)
    return { client, db: drizzle(client) }
  }

  it('merges slug collisions and keeps rebuilt genres visible to enrichment', async () => {
    const { client, db } = await fixture()
    try {
      await client.exec(`
        INSERT INTO artists (name, tags, genres) VALUES
          ('A', ARRAY['Hip Hop'], ARRAY['hip hop', 'hip-hop']),
          ('B', ARRAY[]::text[], ARRAY['hip hop']),
          ('C', ARRAY['hip-hop'], ARRAY[]::text[]);
        INSERT INTO artist_metadata (spotify_genres) VALUES (ARRAY['rock']);
      `)

      expect(await rebuildGenres(db as never)).toMatchObject({ genres: 2 })

      const rows = await client.query<{ name: string; slug: string; artist_count: number }>(
        'SELECT name, slug, artist_count FROM genres ORDER BY slug',
      )
      expect(rows.rows).toEqual([
        { name: 'hip hop', slug: 'hip-hop', artist_count: 3 },
        { name: 'rock', slug: 'rock', artist_count: 1 },
      ])
      const enrichments = await getGenreEnrichments(db as never)
      expect(enrichments.get('hip hop')).toEqual({ examples: ['A', 'B'], liveCount: 2 })
    } finally {
      await client.close()
    }
  })

  it('keeps the previous catalog when the rebuild fails', async () => {
    const { client, db } = await fixture()
    try {
      await client.exec(`
        ALTER TABLE genres ADD CONSTRAINT short_name CHECK (length(name) < 20);
        INSERT INTO artists (name, genres) VALUES ('A', ARRAY['a genre name that is far too long']);
      `)

      await expect(rebuildGenres(db as never)).rejects.toThrow()

      const rows = await client.query<{ slug: string }>('SELECT slug FROM genres')
      expect(rows.rows).toEqual([{ slug: 'old' }])
    } finally {
      await client.close()
    }
  })
})

describe('rescoreRecommendations', () => {
  const weights = {
    consensus: 0.3,
    similarity: 0.25,
    genreOverlap: 0.2,
    aiConfidence: 0.15,
    feedbackBoost: 0.1,
    popularity: 0,
  }
  const components = {
    consensus: 0.25,
    similarity: 0.7,
    genreOverlap: 1,
    aiConfidence: 0.5,
    feedbackBoost: 0.5,
    popularity: 0.9,
  }

  async function fixture() {
    const client = new PGlite()
    await client.exec(`CREATE TABLE recommendations (
      id integer PRIMARY KEY, user_id integer, score real,
      sources jsonb, kind text, status text
    )`)
    const db = drizzle(client)
    async function insert(
      id: number,
      userId: number,
      sources: unknown,
      kind = 'artist',
      status = 'pending',
    ) {
      await client.query('INSERT INTO recommendations VALUES ($1,$2,$3,$4,$5,$6)', [
        id,
        userId,
        0.1,
        JSON.stringify(sources),
        kind,
        status,
      ])
    }
    return { client, db, insert }
  }

  it('reuses component evidence and album modifiers without touching other users or statuses', async () => {
    const { client, db, insert } = await fixture()
    try {
      await insert(1, 1, components)
      await insert(2, 1, { ...components, recency: 1 }, 'album')
      await insert(3, 2, components)
      await insert(4, 1, components, 'artist', 'approved')
      const result = await rescoreRecommendations(db as never, 1, weights)
      expect(result).toMatchObject({ rescored: 2, skipped: 0 })
      const rows = await client.query<{ id: number; score: number; sources: unknown }>(
        'SELECT id,score,sources FROM recommendations ORDER BY id',
      )
      expect(rows.rows[0]?.score).toBeCloseTo(0.575)
      expect(rows.rows[1]?.score).toBeCloseTo(0.71)
      expect(rows.rows[2]?.score).toBeCloseTo(0.1)
      expect(rows.rows[3]?.score).toBeCloseTo(0.1)
      expect(rows.rows[0]?.sources).toEqual(components)
    } finally {
      await client.close()
    }
  })

  it('skips incompatible or invalid evidence and retains legacy zero popularity', async () => {
    const { client, db, insert } = await fixture()
    try {
      const { popularity: _, ...legacy } = components
      await insert(1, 1, legacy)
      await insert(2, 1, { listenbrainz: 0.8 })
      await insert(3, 1, { ...components, feedbackBoost: 2 })
      await insert(4, 1, { ...components, recency: '1' }, 'album')
      await insert(5, 1, components, 'unknown')
      const result = await rescoreRecommendations(db as never, 1, weights)
      expect(result).toMatchObject({ rescored: 1, skippedInvalid: 4, skipped: 4 })
      const rows = await client.query<{ id: number; score: number }>(
        'SELECT id,score FROM recommendations ORDER BY id',
      )
      expect(rows.rows[0]?.score).toBeCloseTo(0.575)
      expect(rows.rows.slice(1).every((row) => Math.abs(row.score - 0.1) < 0.00001)).toBe(true)
    } finally {
      await client.close()
    }
  })

  it('skips rows whose action or score evidence changes after selection', async () => {
    const { client, db, insert } = await fixture()
    try {
      await insert(1, 1, components)
      await insert(2, 1, components)
      await insert(3, 1, components)
      const execute = db.execute.bind(db)
      const raceDb = {
        select: db.select.bind(db),
        execute: async (query: Parameters<typeof db.execute>[0]) => {
          await client.exec(
            "UPDATE recommendations SET status='approved' WHERE id=1; UPDATE recommendations SET score=0.9 WHERE id=2; UPDATE recommendations SET sources='{}' WHERE id=3",
          )
          return execute(query)
        },
      }
      const result = await rescoreRecommendations(raceDb as never, 1, weights, [
        'pending',
        'approved',
      ])
      expect(result).toMatchObject({ rescored: 0, skippedConcurrent: 3, skipped: 3 })
      const rows = await client.query<{ id: number; score: number; status: string }>(
        'SELECT id,score,status FROM recommendations ORDER BY id',
      )
      expect(rows.rows[0]?.status).toBe('approved')
      expect(rows.rows[0]?.score).toBeCloseTo(0.1)
      expect(rows.rows[1]?.score).toBeCloseTo(0.9)
      expect(rows.rows[2]?.score).toBeCloseTo(0.1)
    } finally {
      await client.close()
    }
  })
})
describe('aiReasoningAudit', () => {
  it('flags recommendations where name is missing and genres dont overlap', async () => {
    const recRows = [
      {
        recId: 1,
        aiReasoning: 'A great jazz musician with smooth vocals',
        artistName: 'Metallica',
        artistTags: ['metal', 'thrash'],
        artistGenres: ['heavy metal'],
      },
      {
        recId: 2,
        aiReasoning: 'Radiohead is an innovative rock band',
        artistName: 'Radiohead',
        artistTags: ['alternative', 'rock'],
        artistGenres: ['alternative rock'],
      },
    ]

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(recRows),
          }),
        }),
      }),
    }

    const result = await aiReasoningAudit(db as never)
    expect(result.flagged).toBe(1)
    expect(result.flaggedIds).toContain(1)
    expect(result.flaggedIds).not.toContain(2)
  })

  it('does not flag when name appears in reasoning', async () => {
    const recRows = [
      {
        recId: 1,
        aiReasoning: 'Metallica brings heavy riffs and energy',
        artistName: 'Metallica',
        artistTags: ['pop'],
        artistGenres: ['pop'],
      },
    ]

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(recRows),
          }),
        }),
      }),
    }

    const result = await aiReasoningAudit(db as never)
    expect(result.flagged).toBe(0)
  })

  it('releases the lock when the scan fails', async () => {
    const failingDb = {
      select: vi.fn(() => {
        throw new Error('db down')
      }),
    }
    await expect(aiReasoningAudit(failingDb as never)).rejects.toThrow('db down')
    expect(getAiAuditStatus().inProgress).toBe(false)

    const where = vi.fn().mockResolvedValue([])
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ innerJoin: vi.fn().mockReturnValue({ where }) }),
      }),
    }
    await aiReasoningAudit(db as never)
    expect(where).toHaveBeenCalled()
  })
})
