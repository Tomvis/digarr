# digarr Scoped API Keys — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give digarr a per-user, scoped API-key credential so a machine client (Music Assistant) can read and act on one user's recommendations without a password, a 30-day session, or the deprecated `DIGARR_AUTH_TOKEN`.

**Architecture:** A new `api_keys` table stores SHA-256 hashes of high-entropy secrets, keyed by an indexed public prefix. One branch in the existing `authGuard` recognises `dgr_`-prefixed bearer tokens and populates `userId` plus `apiKeyScopes` on the Hono context. Three existing guards learn about the new auth method, and a new `scopeGuard` narrows what a key may do. Scopes are coarse and ordered — `read` → `write` → `admin` — matching the two access levels digarr already has. Key management is self-service in the Account tab and is reachable by session auth only, so a key can never mint another key.

**Tech Stack:** Bun, Hono 4, Drizzle ORM (Postgres + PGlite), Zod, React 19 + Vite, vitest, Biome.

**Spec:** `~/Projects/music-assistant/server/docs/superpowers/specs/2026-09-13-digarr-integration-design.md` (Part 1)

**Part 2** — the Music Assistant provider that consumes this — is a separate plan: `~/Projects/music-assistant/server/docs/superpowers/plans/2026-09-13-ma-digarr-provider.md`. Part 1 ships and is useful on its own.

## Global Constraints

- **Branch:** work on `oidc-private-issuer` (the deployed fork branch), off `v1.15.1`.
- **Migration tag:** `0900_digarr_api_keys`. Fork migrations use a reserved high range so upstream's next sequential migration never collides. Upstream `develop` and this fork are both at `0049`.
- **Hashing:** SHA-256 hex, following the existing `hashSessionToken` precedent in `src/db/queries/sessions.ts:9`. Never `DIGARR_ENCRYPTION_KEY` (that is AES-256-GCM for credentials digarr must replay outbound), never a password KDF (the secret is already full-entropy).
- **Scopes:** exactly `read`, `write`, `admin`, ordered and implying downward. Scope narrows; it never grants.
- **Key management routes are session-auth only.** An API key must never mint another API key.
- **Query-param API keys are never accepted.** Only `/api/v1/pipeline/events` and `/api/v1/preview/audio` accept `?token=`, and API keys stay out of that path.
- **Docs are enforced:** `bun run check:api-docs` scans `src/server/routes` for `router.<method>('<path>')` and requires a matching `| METHOD | \`path\` |` row in `docs/API.md`. A new route without a docs row fails the check.
- **i18n is enforced:** `bun run i18n:check` blocks on any key missing from the 14 non-English catalogs and rejects values equal to the English source. `bun scripts/i18n-machine-translate.ts <locale> --write` generates a catalog through an OpenAI-compatible endpoint (`TRANSLATION_BASE_URL`, `TRANSLATION_API_KEY`, `TRANSLATION_MODEL`).
- **Test baseline:** the full `bun run test` has ~43 pre-existing `z.object` environment failures under bun-alpine that are **identical on pristine upstream**. Record the baseline count before Task 1 and compare against it; never attribute a pre-existing failure to a change.
- **Commands:** `bun run test`, `bun run typecheck`, `bun run lint`, `bun run db:generate`, `bun run i18n:check`, `bun run check:api-docs`.

---

### Task 0: Record the test baseline

**Files:** none (records a number used by every later task)

- [ ] **Step 1: Capture the pre-change baseline**

```bash
cd ~/Projects/digarr
git checkout oidc-private-issuer
git status --porcelain   # must be clean
bun run test 2>&1 | tail -20
```

Write down the exact "N failed | M passed" line. Every later task compares against these numbers. A task is green when **no new failures** appear — not when the suite is empty of failures.

---

### Task 1: Token primitives and scope model

Pure functions with no database and no HTTP. Everything later builds on these names.

**Files:**
- Create: `src/core/auth/api-keys.ts`
- Test: `tests/core/auth/api-keys.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `const API_KEY_SCOPES = ['read', 'write', 'admin'] as const`
  - `type ApiKeyScope = 'read' | 'write' | 'admin'`
  - `const API_KEY_TOKEN_PREFIX = 'dgr_'`
  - `generateApiKey(): { token: string; prefix: string; keyHash: string }`
  - `parseApiKey(token: string): { prefix: string; secret: string } | null`
  - `hashApiKeySecret(secret: string): string`
  - `isApiKeyToken(token: string): boolean`
  - `scopeSatisfies(granted: readonly string[], required: ApiKeyScope): boolean`
  - `parseScopes(raw: readonly string[]): ApiKeyScope[]`

- [ ] **Step 1: Write the failing test**

Create `tests/core/auth/api-keys.test.ts`:

```ts
// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  API_KEY_SCOPES,
  generateApiKey,
  hashApiKeySecret,
  isApiKeyToken,
  parseApiKey,
  parseScopes,
  scopeSatisfies,
} from '@/core/auth/api-keys'

describe('generateApiKey', () => {
  it('mints a dgr_-prefixed token whose parts round-trip', () => {
    const { token, prefix, keyHash } = generateApiKey()
    expect(token.startsWith('dgr_')).toBe(true)

    const parsed = parseApiKey(token)
    expect(parsed).not.toBeNull()
    expect(parsed?.prefix).toBe(prefix)
    expect(hashApiKeySecret(parsed?.secret ?? '')).toBe(keyHash)
  })

  it('never returns the secret inside the stored hash', () => {
    const { token, keyHash } = generateApiKey()
    const secret = parseApiKey(token)?.secret ?? ''
    expect(secret.length).toBeGreaterThan(20)
    expect(keyHash).not.toContain(secret)
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is unique across mints', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateApiKey().token))
    expect(tokens.size).toBe(50)
  })
})

describe('parseApiKey', () => {
  it('rejects tokens that are not api keys', () => {
    expect(parseApiKey('')).toBeNull()
    expect(parseApiKey('sessiontoken')).toBeNull()
    expect(parseApiKey('dgr_')).toBeNull()
    expect(parseApiKey('dgr_onlyprefix')).toBeNull()
    expect(parseApiKey('dgr__emptyprefix')).toBeNull()
  })

  it('does not split on extra underscores inside the secret', () => {
    const { token, prefix } = generateApiKey()
    const parsed = parseApiKey(`${token}_tail`)
    expect(parsed?.prefix).toBe(prefix)
    expect(parsed?.secret.endsWith('_tail')).toBe(true)
  })
})

describe('isApiKeyToken', () => {
  it('recognises api-key tokens without parsing them', () => {
    expect(isApiKeyToken(generateApiKey().token)).toBe(true)
    expect(isApiKeyToken('some-session-token')).toBe(false)
  })
})

describe('scopeSatisfies', () => {
  it('treats scopes as ordered, each implying the ones below', () => {
    expect(scopeSatisfies(['admin'], 'read')).toBe(true)
    expect(scopeSatisfies(['admin'], 'write')).toBe(true)
    expect(scopeSatisfies(['admin'], 'admin')).toBe(true)
    expect(scopeSatisfies(['write'], 'read')).toBe(true)
    expect(scopeSatisfies(['write'], 'write')).toBe(true)
    expect(scopeSatisfies(['read'], 'read')).toBe(true)
  })

  it('never grants upward', () => {
    expect(scopeSatisfies(['read'], 'write')).toBe(false)
    expect(scopeSatisfies(['read'], 'admin')).toBe(false)
    expect(scopeSatisfies(['write'], 'admin')).toBe(false)
  })

  it('ignores unknown scopes and empty grants', () => {
    expect(scopeSatisfies([], 'read')).toBe(false)
    expect(scopeSatisfies(['nonsense'], 'read')).toBe(false)
    expect(scopeSatisfies(['nonsense', 'write'], 'read')).toBe(true)
  })
})

describe('parseScopes', () => {
  it('keeps known scopes in canonical order and drops the rest', () => {
    expect(parseScopes(['write', 'read'])).toEqual(['read', 'write'])
    expect(parseScopes(['bogus'])).toEqual([])
    expect(parseScopes(['admin', 'admin'])).toEqual(['admin'])
  })
})

describe('API_KEY_SCOPES', () => {
  it('is exactly the three ordered scopes', () => {
    expect([...API_KEY_SCOPES]).toEqual(['read', 'write', 'admin'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd ~/Projects/digarr && bun run test tests/core/auth/api-keys.test.ts
```

Expected: FAIL — cannot resolve `@/core/auth/api-keys`.

- [ ] **Step 3: Write the implementation**

Create `src/core/auth/api-keys.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto'

/**
 * Ordered scopes. Each implies every scope below it, which mirrors the two
 * access levels digarr already enforces (authenticated, admin) instead of
 * introducing a resource taxonomy the project would have to live with.
 */
export const API_KEY_SCOPES = ['read', 'write', 'admin'] as const
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number]

export const API_KEY_TOKEN_PREFIX = 'dgr_'

/** Public, indexed lookup handle. Not a secret. */
const PREFIX_BYTES = 4
/** 256 bits of CSPRNG material. Full entropy, so a plain digest is sufficient. */
const SECRET_BYTES = 32

const SCOPE_RANK: Record<ApiKeyScope, number> = { read: 0, write: 1, admin: 2 }

function isScope(value: string): value is ApiKeyScope {
  return value in SCOPE_RANK
}

/**
 * Hash a key secret before storage or lookup so plaintext secrets never touch
 * the DB. Mirrors `hashSessionToken`. A password KDF would be wrong here: the
 * secret is already full-entropy, so stretching buys no brute-force resistance
 * and costs a stretch on every authenticated request.
 */
export function hashApiKeySecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

export function generateApiKey(): { token: string; prefix: string; keyHash: string } {
  const prefix = randomBytes(PREFIX_BYTES).toString('hex')
  const secret = randomBytes(SECRET_BYTES).toString('base64url')
  return {
    token: `${API_KEY_TOKEN_PREFIX}${prefix}_${secret}`,
    prefix,
    keyHash: hashApiKeySecret(secret),
  }
}

export function isApiKeyToken(token: string): boolean {
  return token.startsWith(API_KEY_TOKEN_PREFIX)
}

export function parseApiKey(token: string): { prefix: string; secret: string } | null {
  if (!isApiKeyToken(token)) return null
  const body = token.slice(API_KEY_TOKEN_PREFIX.length)
  const separator = body.indexOf('_')
  if (separator <= 0) return null
  const prefix = body.slice(0, separator)
  // Split on the FIRST separator only: base64url excludes '_' but a malformed
  // or future token must not silently lose secret material to a greedy split.
  const secret = body.slice(separator + 1)
  if (!prefix || !secret) return null
  return { prefix, secret }
}

export function parseScopes(raw: readonly string[]): ApiKeyScope[] {
  const known = new Set(raw.filter(isScope))
  return API_KEY_SCOPES.filter((scope) => known.has(scope))
}

export function scopeSatisfies(granted: readonly string[], required: ApiKeyScope): boolean {
  const needed = SCOPE_RANK[required]
  return granted.some((scope) => isScope(scope) && SCOPE_RANK[scope] >= needed)
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd ~/Projects/digarr && bun run test tests/core/auth/api-keys.test.ts && bun run typecheck && bun run lint
```

Expected: all tests PASS, typecheck clean, lint clean.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/digarr
git add src/core/auth/api-keys.ts tests/core/auth/api-keys.test.ts
git commit -m "feat(auth): add API key token primitives and ordered scope model"
```

---

### Task 2: Schema, migration, and the queries layer

**Files:**
- Modify: `src/db/schema.ts` (append a table; the file groups tables, add near `sessions` at `:392`)
- Create: `drizzle/0900_digarr_api_keys.sql` (generated, then renamed)
- Modify: `drizzle/meta/_journal.json` (rename the generated tag)
- Create: `src/db/queries/api-keys.ts`
- Test: `tests/db/api-keys.test.ts`

**Interfaces:**
- Consumes: `hashApiKeySecret`, `ApiKeyScope` from Task 1.
- Produces:
  - `apiKeys` Drizzle table export from `src/db/schema.ts`
  - `apiKeyQueries(db): ApiKeyStore` with:
    - `create(params: { userId: number; name: string; prefix: string; keyHash: string; scopes: ApiKeyScope[]; expiresAt: Date | null }): Promise<ApiKeyRow>`
    - `verify(prefix: string, secret: string): Promise<{ id: number; userId: number; scopes: string[] } | null>`
    - `listForUser(userId: number): Promise<ApiKeyRow[]>`
    - `listAll(): Promise<ApiKeyRow[]>`
    - `revoke(params: { id: number; userId: number | null }): Promise<boolean>`
    - `touchLastUsed(id: number): Promise<void>`
  - `type ApiKeyRow = { id, userId, name, prefix, scopes, createdAt, lastUsedAt, expiresAt, revokedAt }` — **never** includes `keyHash`.
  - `const API_KEY_TOUCH_THROTTLE_MS = 60_000`

- [ ] **Step 1: Write the failing test**

Create `tests/db/api-keys.test.ts`, using the real harness `makeTestDb()` from `tests/helpers/test-db.ts` and creating users inline, exactly as `tests/db/session-queries.test.ts:27-45` does.

```ts
// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateApiKey, hashApiKeySecret, parseApiKey } from '@/core/auth/api-keys'
import type { Database } from '@/db'
import { apiKeyQueries } from '@/db/queries/api-keys'
import { apiKeys, users } from '@/db/schema'
import { makeTestDb } from '../helpers/test-db'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

describe('apiKeyQueries', () => {
  let db: Database
  let close: () => Promise<void>
  let store: ReturnType<typeof apiKeyQueries>
  let userId: number

  async function createUser(username: string): Promise<number> {
    const [user] = await db
      .insert(users)
      .values({ username, passwordHash: 'test-password-hash' })
      .returning({ id: users.id })
    if (!user) throw new Error('test user was not created')
    return user.id
  }

  beforeEach(async () => {
    const testDb = await makeTestDb()
    db = testDb.db as unknown as Database
    close = testDb.close
    store = apiKeyQueries(db)
    userId = await createUser('tom')
  })

  afterEach(async () => {
    await close()
  })

  async function mint(scopes: Array<'read' | 'write' | 'admin'> = ['read']) {
    const { token, prefix, keyHash } = generateApiKey()
    const row = await store.create({ userId, name: 'MA', prefix, keyHash, scopes, expiresAt: null })
    return { token, row, parsed: parseApiKey(token) }
  }

  it('verifies a freshly minted key', async () => {
    const { parsed } = await mint(['write'])
    const result = await store.verify(parsed?.prefix ?? '', parsed?.secret ?? '')
    expect(result?.userId).toBe(userId)
    expect(result?.scopes).toEqual(['write'])
  })

  it('rejects a correct prefix with the wrong secret', async () => {
    const { parsed } = await mint()
    const result = await store.verify(parsed?.prefix ?? '', 'not-the-secret')
    expect(result).toBeNull()
  })

  it('rejects an unknown prefix', async () => {
    await mint()
    expect(await store.verify('deadbeef', 'anything')).toBeNull()
  })

  it('rejects a revoked key', async () => {
    const { row, parsed } = await mint()
    expect(await store.revoke({ id: row.id, userId })).toBe(true)
    expect(await store.verify(parsed?.prefix ?? '', parsed?.secret ?? '')).toBeNull()
  })

  it('rejects an expired key', async () => {
    const { token, prefix, keyHash } = generateApiKey()
    await store.create({
      userId,
      name: 'stale',
      prefix,
      keyHash,
      scopes: ['read'],
      expiresAt: new Date(Date.now() - 1000),
    })
    const parsed = parseApiKey(token)
    expect(await store.verify(parsed?.prefix ?? '', parsed?.secret ?? '')).toBeNull()
  })

  it('never exposes the hash through the listing surface', async () => {
    await mint()
    const [listed] = await store.listForUser(userId)
    expect(listed).toBeDefined()
    expect(Object.keys(listed ?? {})).not.toContain('keyHash')
  })

  it('will not let one user revoke another user\'s key', async () => {
    const otherId = await createUser('lera')
    const { row, parsed } = await mint()
    expect(await store.revoke({ id: row.id, userId: otherId })).toBe(false)
    // Still usable: the failed revoke must not have taken effect.
    expect(await store.verify(parsed?.prefix ?? '', parsed?.secret ?? '')).not.toBeNull()
  })

  it('records last-used on touch', async () => {
    const { row } = await mint()
    await store.touchLastUsed(row.id)
    const [listed] = await store.listForUser(userId)
    expect(listed?.lastUsedAt).not.toBeNull()
  })

  it('stores only the hash of the secret', async () => {
    const { token } = await mint()
    const secret = parseApiKey(token)?.secret ?? ''
    const rows = await db.select().from(apiKeys)
    expect(rows[0]?.keyHash).toBe(hashApiKeySecret(secret))
    expect(rows[0]?.keyHash).not.toBe(secret)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd ~/Projects/digarr && bun run test tests/db/api-keys.test.ts
```

Expected: FAIL — cannot resolve `@/db/queries/api-keys`.

- [ ] **Step 3: Add the table to the schema**

Append to `src/db/schema.ts`, after the `sessions` table (`:392-406`):

```ts
export const apiKeys = pgTable(
  'api_keys',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // Public lookup handle carried in the token. Unique because it is the
    // index we resolve on before the constant-time hash comparison.
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    scopes: text('scopes').array().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => ({
    prefixUnique: uniqueIndex('api_keys_prefix_unique').on(table.prefix),
    userIdx: index('api_keys_user_idx').on(table.userId),
  }),
)
```

`uniqueIndex` and `index` are already imported at `src/db/schema.ts:1-18`.

- [ ] **Step 4: Generate the migration and move it into the reserved range**

```bash
cd ~/Projects/digarr && bun run db:generate
```

Drizzle writes `drizzle/0050_<random>.sql` and appends a journal entry tagged `0050_<random>`. Move it into the fork's reserved range:

```bash
cd ~/Projects/digarr
ls drizzle/0050_*.sql                      # note the generated name
git mv drizzle/0050_<generated>.sql drizzle/0900_digarr_api_keys.sql
```

Then edit `drizzle/meta/_journal.json`: on the newly appended entry only, change `"tag": "0050_<generated>"` to `"tag": "0900_digarr_api_keys"`. Leave `idx`, `when`, `version` and every existing entry untouched — Drizzle applies entries in array order and records them by hash, so the tag is a filename pointer, not an ordering key.

Verify the SQL creates `api_keys` with the unique index, and that nothing else was captured:

```bash
cd ~/Projects/digarr && cat drizzle/0900_digarr_api_keys.sql
```

If the generated SQL contains any statement unrelated to `api_keys`, the working tree had drift — stop and resolve that before continuing.

- [ ] **Step 5: Write the queries module**

Create `src/db/queries/api-keys.ts`:

```ts
import { timingSafeEqual } from 'node:crypto'
import { and, eq, isNull, or } from 'drizzle-orm'
import { type ApiKeyScope, hashApiKeySecret } from '@/core/auth/api-keys'
import type { Database } from '@/db'
import { apiKeys } from '../schema'

/**
 * Minimum gap between `last_used_at` writes for a single key, so a polling
 * reader does not turn every authenticated read into a database write.
 */
export const API_KEY_TOUCH_THROTTLE_MS = 60_000

/** Listing shape. Deliberately omits `keyHash` so it cannot leak through a route. */
export type ApiKeyRow = {
  id: number
  userId: number
  name: string
  prefix: string
  scopes: string[]
  createdAt: Date
  lastUsedAt: Date | null
  expiresAt: Date | null
  revokedAt: Date | null
}

const LIST_COLUMNS = {
  id: apiKeys.id,
  userId: apiKeys.userId,
  name: apiKeys.name,
  prefix: apiKeys.prefix,
  scopes: apiKeys.scopes,
  createdAt: apiKeys.createdAt,
  lastUsedAt: apiKeys.lastUsedAt,
  expiresAt: apiKeys.expiresAt,
  revokedAt: apiKeys.revokedAt,
}

/** Constant-time hex-digest comparison. Both operands are fixed-length SHA-256 hex. */
function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function apiKeyQueries(db: Database) {
  return {
    async create(params: {
      userId: number
      name: string
      prefix: string
      keyHash: string
      scopes: ApiKeyScope[]
      expiresAt: Date | null
    }): Promise<ApiKeyRow> {
      const [row] = await db
        .insert(apiKeys)
        .values({
          userId: params.userId,
          name: params.name,
          prefix: params.prefix,
          keyHash: params.keyHash,
          scopes: params.scopes,
          expiresAt: params.expiresAt,
        })
        .returning(LIST_COLUMNS)
      if (!row) throw new Error('Failed to create API key')
      return row
    },

    async verify(
      prefix: string,
      secret: string,
    ): Promise<{ id: number; userId: number; scopes: string[] } | null> {
      if (!prefix || !secret) return null
      const [row] = await db
        .select({
          id: apiKeys.id,
          userId: apiKeys.userId,
          scopes: apiKeys.scopes,
          keyHash: apiKeys.keyHash,
          expiresAt: apiKeys.expiresAt,
        })
        .from(apiKeys)
        .where(and(eq(apiKeys.prefix, prefix), isNull(apiKeys.revokedAt)))
        .limit(1)
      if (!row) return null
      if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null
      if (!hashesMatch(row.keyHash, hashApiKeySecret(secret))) return null
      return { id: row.id, userId: row.userId, scopes: row.scopes }
    },

    async listForUser(userId: number): Promise<ApiKeyRow[]> {
      return db.select(LIST_COLUMNS).from(apiKeys).where(eq(apiKeys.userId, userId))
    },

    async listAll(): Promise<ApiKeyRow[]> {
      return db.select(LIST_COLUMNS).from(apiKeys)
    },

    /** `userId: null` means an admin acting on any key. */
    async revoke(params: { id: number; userId: number | null }): Promise<boolean> {
      const ownership =
        params.userId === null ? undefined : eq(apiKeys.userId, params.userId)
      const revoked = await db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(
          ownership
            ? and(eq(apiKeys.id, params.id), isNull(apiKeys.revokedAt), ownership)
            : and(eq(apiKeys.id, params.id), isNull(apiKeys.revokedAt)),
        )
        .returning({ id: apiKeys.id })
      return revoked.length === 1
    },

    async touchLastUsed(id: number): Promise<void> {
      await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, id))
    },
  }
}

export type ApiKeyStore = ReturnType<typeof apiKeyQueries>
```

If `or` is unused after implementation, remove it from the import — Biome will flag it.

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd ~/Projects/digarr && bun run test tests/db/api-keys.test.ts && bun run typecheck && bun run lint
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
cd ~/Projects/digarr
git add src/db/schema.ts src/db/queries/api-keys.ts drizzle/0900_digarr_api_keys.sql drizzle/meta/_journal.json tests/db/api-keys.test.ts
git commit -m "feat(db): add api_keys table, reserved-range migration, and query layer"
```

---

### Task 3: Recognise API keys in authGuard

**Files:**
- Modify: `src/server/types.ts` (extend `AuthMethod` and `HonoEnv.Variables`)
- Modify: `src/server/middleware/auth.ts` (new branch between `:92` and `:103`)
- Test: `tests/server/middleware/api-key-auth.test.ts`

**Interfaces:**
- Consumes: `isApiKeyToken`, `parseApiKey` (Task 1); `ApiKeyStore.verify`, `touchLastUsed`, `API_KEY_TOUCH_THROTTLE_MS` (Task 2).
- Produces: on a valid key the context carries `userId`, `authMethod: 'api-key'`, `apiKeyId: number`, `apiKeyScopes: string[]`. `authGuard` gains an `options.apiKeys?: ApiKeyStore` field.

- [ ] **Step 1: Write the failing test**

Create `tests/server/middleware/api-key-auth.test.ts`. Mirror the harness in the sibling `tests/server/middleware/auth.test.ts` — open it and copy how it builds the Hono app and stubs `getSession`.

```ts
// @vitest-environment node

import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { generateApiKey } from '@/core/auth/api-keys'
import { authGuard } from '@/server/middleware/auth'
import type { HonoEnv } from '@/server/types'

function appWith(verify: ReturnType<typeof vi.fn>, touchLastUsed = vi.fn(async () => {})) {
  const app = new Hono<HonoEnv>()
  app.use(
    '*',
    authGuard({
      hasUsers: async () => true,
      isSetupComplete: async () => true,
      apiKeys: { verify, touchLastUsed } as never,
    }),
  )
  app.get('/api/v1/recommendations', (c) =>
    c.json({
      userId: c.get('userId'),
      authMethod: c.get('authMethod'),
      scopes: c.get('apiKeyScopes'),
    }),
  )
  return app
}

describe('authGuard api-key branch', () => {
  it('authenticates a valid key and exposes its scopes', async () => {
    const { token } = generateApiKey()
    const verify = vi.fn(async () => ({ id: 7, userId: 2, scopes: ['read', 'write'] }))
    const res = await appWith(verify).request('/api/v1/recommendations', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      userId: 2,
      authMethod: 'api-key',
      scopes: ['read', 'write'],
    })
  })

  it('rejects an unknown or revoked key with 401', async () => {
    const { token } = generateApiKey()
    const verify = vi.fn(async () => null)
    const res = await appWith(verify).request('/api/v1/recommendations', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(401)
  })

  it('never accepts an api key as a query parameter', async () => {
    const { token } = generateApiKey()
    const verify = vi.fn(async () => ({ id: 7, userId: 2, scopes: ['admin'] }))
    const res = await appWith(verify).request(
      `/api/v1/pipeline/events?token=${encodeURIComponent(token)}`,
    )
    expect(res.status).toBe(401)
    expect(verify).not.toHaveBeenCalled()
  })

  it('throttles last-used writes to one per key per minute', async () => {
    const { token } = generateApiKey()
    const verify = vi.fn(async () => ({ id: 7, userId: 2, scopes: ['read'] }))
    const touch = vi.fn(async () => {})
    const app = appWith(verify, touch)
    const headers = { Authorization: `Bearer ${token}` }
    await app.request('/api/v1/recommendations', { headers })
    await app.request('/api/v1/recommendations', { headers })
    await app.request('/api/v1/recommendations', { headers })
    expect(touch).toHaveBeenCalledTimes(1)
  })

  it('does not consult the session store for a dgr_ token', async () => {
    const { token } = generateApiKey()
    const verify = vi.fn(async () => ({ id: 1, userId: 1, scopes: ['read'] }))
    const res = await appWith(verify).request('/api/v1/recommendations', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    expect(verify).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd ~/Projects/digarr && bun run test tests/server/middleware/api-key-auth.test.ts
```

Expected: FAIL — `authGuard` does not accept an `apiKeys` option and never sets `authMethod: 'api-key'`.

- [ ] **Step 3: Extend the context types**

In `src/server/types.ts`, add `'api-key'` to the union and two variables:

```ts
export type AuthMethod =
  | 'session-bearer'
  | 'session-cookie'
  | 'session-query'
  | 'legacy-bearer'
  | 'legacy-query'
  | 'api-key'
  | 'proxy'

export type HonoEnv = {
  Variables: {
    userId?: number
    authMethod?: AuthMethod
    proxyAuth?: boolean
    legacyTokenAuth?: boolean
    /** Id of the API key that authenticated this request, when authMethod is 'api-key'. */
    apiKeyId?: number
    /** Scopes granted to that key. Absent for every other auth method, which are unscoped. */
    apiKeyScopes?: string[]
    /** True when auth middleware determined no auth is configured (no users, no legacy token). */
    authSkipped?: boolean
  }
}
```

- [ ] **Step 4: Add the branch to authGuard**

In `src/server/middleware/auth.ts`, widen the options type on `authGuard` (`:54`) to include `apiKeys?: ApiKeyStore`, import `isApiKeyToken` / `parseApiKey` from `@/core/auth/api-keys` and the `ApiKeyStore` type from `@/db/queries/api-keys`, and add a module-level throttle map:

```ts
const lastTouchedAt = new Map<number, number>()
```

Then insert this **before** the existing session attempt at `:92`, so a `dgr_` token never costs a session lookup:

```ts
    // API key auth. Recognised by prefix so it costs no session lookup, and
    // never from a query parameter: only SSE/audio accept ?token=, and a
    // long-lived credential has no business in a URL.
    if (
      options.apiKeys &&
      credential?.token &&
      credential.source === 'bearer' &&
      isApiKeyToken(credential.token)
    ) {
      const parsed = parseApiKey(credential.token)
      const verified = parsed
        ? await options.apiKeys.verify(parsed.prefix, parsed.secret)
        : null
      if (verified) {
        c.set('userId', verified.userId)
        c.set('authMethod', 'api-key')
        c.set('apiKeyId', verified.id)
        c.set('apiKeyScopes', verified.scopes)

        const now = Date.now()
        const previous = lastTouchedAt.get(verified.id) ?? 0
        if (now - previous >= API_KEY_TOUCH_THROTTLE_MS) {
          lastTouchedAt.set(verified.id, now)
          // Fire and forget: a read must not become a write on the hot path.
          void options.apiKeys.touchLastUsed(verified.id).catch(() => {})
        }
        return next()
      }
      // A presented-but-invalid api key falls through to the 401 below. It must
      // NOT fall back to the legacy token: that would let a revoked key keep
      // working whenever DIGARR_AUTH_TOKEN happens to be configured.
      return notAuthenticated(c)
    }
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd ~/Projects/digarr && bun run test tests/server/middleware/ && bun run typecheck && bun run lint
```

Expected: the new file PASSes and the existing `auth.test.ts`, `csrf.test.ts`, `proxy-auth.test.ts`, `session-cookie.test.ts` still pass.

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/digarr
git add src/server/types.ts src/server/middleware/auth.ts tests/server/middleware/api-key-auth.test.ts
git commit -m "feat(auth): authenticate dgr_ API keys in authGuard"
```

---

### Task 4: Teach the existing guards about API keys

This is the security-critical task. `requireSessionUser` currently rejects only `legacyTokenAuth`, so without this change an API key passes every check that is supposed to mean "a real session" — including the key-management routes added in Task 5, which would let a key mint another key.

**Files:**
- Modify: `src/server/middleware/csrf.ts` (add `'api-key'` to `HEADER_AUTH`)
- Modify: `src/server/middleware/admin-guard.ts` (`adminGuard` at `:16`, `resolveAdmin` at `:37`)
- Modify: `src/server/helpers/require-user.ts` (`requireSessionUser` at `:28`)
- Create: `src/server/middleware/scope-guard.ts`
- Test: `tests/server/middleware/api-key-guards.test.ts`

**Interfaces:**
- Consumes: `scopeSatisfies`, `ApiKeyScope` (Task 1); the context variables from Task 3.
- Produces: `scopeGuard(required: ApiKeyScope)` middleware. Unscoped auth methods (session, cookie, proxy, authSkipped) always pass; only `api-key` is evaluated.

- [ ] **Step 1: Write the failing test**

Create `tests/server/middleware/api-key-guards.test.ts`:

```ts
// @vitest-environment node

import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { adminGuard, resolveAdmin } from '@/server/middleware/admin-guard'
import { scopeGuard } from '@/server/middleware/scope-guard'
import { requireSessionUser } from '@/server/helpers/require-user'
import type { AuthMethod, HonoEnv } from '@/server/types'

function appAs(
  authMethod: AuthMethod,
  scopes: string[] | undefined,
  mount: (app: Hono<HonoEnv>) => void,
) {
  const app = new Hono<HonoEnv>()
  app.use('*', async (c, next) => {
    c.set('userId', 1)
    c.set('authMethod', authMethod)
    if (scopes) c.set('apiKeyScopes', scopes)
    await next()
  })
  mount(app)
  return app
}

const adminUser = vi.fn(async () => ({ isAdmin: true }))

describe('scopeGuard', () => {
  it('admits an api key carrying the required scope', async () => {
    const app = appAs('api-key', ['write'], (a) => {
      a.use('/w', scopeGuard('write'))
      a.post('/w', (c) => c.json({ ok: true }))
    })
    expect((await app.request('/w', { method: 'POST' })).status).toBe(200)
  })

  it('refuses an api key that lacks it', async () => {
    const app = appAs('api-key', ['read'], (a) => {
      a.use('/w', scopeGuard('write'))
      a.post('/w', (c) => c.json({ ok: true }))
    })
    expect((await app.request('/w', { method: 'POST' })).status).toBe(403)
  })

  it('leaves session auth unscoped', async () => {
    const app = appAs('session-bearer', undefined, (a) => {
      a.use('/w', scopeGuard('admin'))
      a.post('/w', (c) => c.json({ ok: true }))
    })
    expect((await app.request('/w', { method: 'POST' })).status).toBe(200)
  })
})

describe('adminGuard with api keys', () => {
  it('refuses an ADMIN user whose key lacks the admin scope', async () => {
    const app = appAs('api-key', ['write'], (a) => {
      a.use('/a', adminGuard(adminUser))
      a.get('/a', (c) => c.json({ ok: true }))
    })
    expect((await app.request('/a')).status).toBe(403)
  })

  it('admits an admin user whose key carries the admin scope', async () => {
    const app = appAs('api-key', ['admin'], (a) => {
      a.use('/a', adminGuard(adminUser))
      a.get('/a', (c) => c.json({ ok: true }))
    })
    expect((await app.request('/a')).status).toBe(200)
  })

  it('refuses a NON-admin user whose key carries the admin scope', async () => {
    const app = appAs('api-key', ['admin'], (a) => {
      a.use('/a', adminGuard(vi.fn(async () => ({ isAdmin: false }))))
      a.get('/a', (c) => c.json({ ok: true }))
    })
    expect((await app.request('/a')).status).toBe(403)
  })

  it('resolveAdmin agrees with adminGuard for a scoped key', async () => {
    expect(await resolveAdmin(1, adminUser, false, false, 'api-key', ['write'])).toBe(false)
    expect(await resolveAdmin(1, adminUser, false, false, 'api-key', ['admin'])).toBe(true)
  })
})

describe('requireSessionUser', () => {
  it('rejects api-key auth, not just legacy tokens', async () => {
    const app = appAs('api-key', ['admin'], (a) => {
      a.get('/s', (c) => {
        const auth = requireSessionUser(c)
        return auth.ok ? c.json({ ok: true }) : auth.response
      })
    })
    expect((await app.request('/s')).status).toBe(403)
  })

  it('still admits a real session', async () => {
    const app = appAs('session-bearer', undefined, (a) => {
      a.get('/s', (c) => {
        const auth = requireSessionUser(c)
        return auth.ok ? c.json({ ok: true }) : auth.response
      })
    })
    expect((await app.request('/s')).status).toBe(200)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd ~/Projects/digarr && bun run test tests/server/middleware/api-key-guards.test.ts
```

Expected: FAIL — `@/server/middleware/scope-guard` does not exist, and `requireSessionUser` admits the api-key caller.

- [ ] **Step 3: Create scopeGuard**

Create `src/server/middleware/scope-guard.ts`:

```ts
import { createMiddleware } from 'hono/factory'
import { type ApiKeyScope, scopeSatisfies } from '@/core/auth/api-keys'
import { problem } from '@/server/helpers/problem'
import type { HonoEnv } from '@/server/types'

/**
 * Narrow what an API key may do. Session, cookie and proxy auth carry the
 * user's full rights and are deliberately unscoped — a scope never grants
 * access, it only withholds it from a key.
 */
export function scopeGuard(required: ApiKeyScope) {
  return createMiddleware<HonoEnv>(async (c, next) => {
    if (c.get('authMethod') !== 'api-key') return next()
    if (scopeSatisfies(c.get('apiKeyScopes') ?? [], required)) return next()
    // Signature is problem(c, type, title, status, detail?) -- status is the
    // FOURTH argument (src/server/helpers/problem.ts:21).
    return problem(
      c,
      'insufficient-scope',
      'Insufficient scope',
      403,
      `This API key does not carry the '${required}' scope.`,
    )
  })
}
```

- [ ] **Step 4: Update the three existing guards**

`src/server/middleware/csrf.ts` — add `'api-key'` to the `HEADER_AUTH` set near the top of the file. Header-borne credentials are not attacker-controllable cross-origin, which is exactly why `session-bearer` is already there.

`src/server/middleware/admin-guard.ts` — in `adminGuard`, after the `legacyTokenAuth` rejection:

```ts
    if (c.get('authMethod') === 'api-key' && !scopeSatisfies(c.get('apiKeyScopes') ?? [], 'admin')) {
      return adminRequired(c)
    }
```

and widen `resolveAdmin` with two optional trailing parameters so its verdict cannot drift from the middleware's:

```ts
export async function resolveAdmin(
  userId: number | undefined,
  getUserById: GetUserById,
  authSkipped?: boolean,
  legacyTokenAuth?: boolean,
  authMethod?: AuthMethod,
  apiKeyScopes?: string[],
): Promise<boolean> {
  if (authSkipped) return true
  if (legacyTokenAuth) return false
  if (authMethod === 'api-key' && !scopeSatisfies(apiKeyScopes ?? [], 'admin')) return false
  if (!userId) return false
  const user = await getUserById(userId)
  return user?.isAdmin ?? false
}
```

Then update every existing `resolveAdmin(...)` call site to pass `c.get('authMethod')` and `c.get('apiKeyScopes')`. Find them with:

```bash
cd ~/Projects/digarr && grep -rn "resolveAdmin(" src/ | grep -v "admin-guard.ts"
```

`src/server/helpers/require-user.ts` — in `requireSessionUser`:

```ts
export function requireSessionUser(c: Context<HonoEnv>): RequireUserResult {
  const auth = requireUser(c)
  if (!auth.ok) return auth
  if (c.get('legacyTokenAuth') || c.get('authMethod') === 'api-key') {
    return { ok: false, response: sessionAuthRequired(c) }
  }
  return auth
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd ~/Projects/digarr && bun run test tests/server/ && bun run typecheck && bun run lint
```

Expected: new tests PASS; no new failures anywhere in `tests/server/`.

- [ ] **Step 6: Verify each guard test actually guards**

For each of the three changes, revert it locally, confirm the matching test fails, then restore it. A guard test that passes with the guard removed is not testing the guard.

```bash
cd ~/Projects/digarr
# Example for requireSessionUser: temporarily drop the `|| c.get('authMethod') === 'api-key'`
bun run test tests/server/middleware/api-key-guards.test.ts   # must FAIL
git checkout src/server/helpers/require-user.ts
```

- [ ] **Step 7: Commit**

```bash
cd ~/Projects/digarr
git add src/server/middleware/csrf.ts src/server/middleware/admin-guard.ts src/server/middleware/scope-guard.ts src/server/helpers/require-user.ts tests/server/middleware/api-key-guards.test.ts
git add -u src/
git commit -m "feat(auth): scope-limit API keys across csrf, admin, and session guards

requireSessionUser previously rejected only legacy tokens, so an API key
would have satisfied every 'real session' check -- including the key
management routes, letting a key mint another key."
```

---

### Task 5: Key management routes

**Files:**
- Create: `src/server/routes/api-keys.ts`
- Modify: `src/server/deps.ts` (new `ApiKeyDeps` slice, added to the `AppDependencies` intersection at `:270`)
- Modify: `src/server/index.ts` (mount, near the other `app.route('/', ...)` calls at `:298-310`)
- Modify: `src/index.ts` (construct the store and wire the deps, near `sessionQueries(db)` at `:247`)
- Modify: `docs/API.md`
- Create: `src/server/schemas/api-keys.ts`
- Test: `tests/api-routes/api-keys.test.ts`

**Interfaces:**
- Consumes: `apiKeyQueries`/`ApiKeyStore`/`ApiKeyRow` (Task 2), `generateApiKey`/`parseScopes`/`API_KEY_SCOPES` (Task 1), `requireSessionUser` (Task 4).
- Produces: routes `GET /api/v1/api-keys`, `POST /api/v1/api-keys`, `DELETE /api/v1/api-keys/:id`. `POST` responds `{ key: ApiKeyRow, token: string }`; `GET` responds `{ items: ApiKeyRow[] }`. `token` appears in the `POST` response only and is never stored in plaintext.
- `AppDependencies` gains a single field `apiKeyStore: ApiKeyStore`. One object serves both the routes and the `authGuard` option from Task 3, so there is one wiring path and one thing to stub in tests. This departs slightly from the flat per-function convention in `deps.ts`, deliberately: three flat functions plus a store for the guard would mean wiring the same queries twice.

- [ ] **Step 1: Write the failing test**

The real harness is `createTestApp(overrides)` from `tests/helpers/test-app.ts`, which builds a genuine Hono app from a full mocked `AppDependencies`. Authentication in these tests works by mocking `@/core/sessions`, as `tests/api-routes/recommendations.test.ts:5-12` does — there are no `sessionHeaders`-style helpers.

First extend the shared helper: in `tests/helpers/test-app.ts`, add `apiKeyStore` to the object `makeDeps` returns, since it is now a required field of `AppDependencies`:

```ts
    apiKeyStore: {
      create: vi.fn(async () => {
        throw new Error('apiKeyStore.create not stubbed')
      }),
      verify: vi.fn(async () => null),
      listForUser: vi.fn(async () => []),
      listAll: vi.fn(async () => []),
      revoke: vi.fn(async () => false),
      touchLastUsed: vi.fn(async () => {}),
    } as unknown as AppDependencies['apiKeyStore'],
```

Then create `tests/api-routes/api-keys.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createTestApp } from '../helpers/test-app'

const getSession = vi.fn(async () => ({
  userId: 1,
  token: 'tok',
  expiresAt: new Date(Date.now() + 86400000),
}))

vi.mock('@/core/sessions', () => ({ getSession: (t: string) => getSession(t) }))

const AUTH = { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    userId: 1,
    name: 'Music Assistant',
    prefix: 'ab12cd34',
    scopes: ['read', 'write'],
    createdAt: new Date(),
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  }
}

describe('POST /api/v1/api-keys', () => {
  it('returns the plaintext token exactly once, and never stores it', async () => {
    const create = vi.fn(async (p: { keyHash: string }) => {
      // The route must hand the store a HASH, never the secret itself.
      expect(p.keyHash).toMatch(/^[0-9a-f]{64}$/)
      return row()
    })
    const { app } = createTestApp({
      apiKeyStore: { create, listForUser: vi.fn(async () => [row()]) } as never,
    })

    const res = await app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ name: 'Music Assistant', scopes: ['read', 'write'] }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.token).toMatch(/^dgr_/)
    expect(body.key).not.toHaveProperty('keyHash')

    const listed = await (
      await app.request('/api/v1/api-keys', { headers: AUTH })
    ).text()
    expect(listed).not.toContain(body.token)
  })

  it('rejects unknown scopes', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ name: 'bad', scopes: ['superuser'] }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects an empty scope list', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ name: 'bad', scopes: [] }),
    })
    expect(res.status).toBe(400)
  })

  it('cannot be called with an API key, only a session', async () => {
    // No session for this token; the api-key branch authenticates it instead.
    getSession.mockResolvedValueOnce(null as never)
    const { app } = createTestApp({
      apiKeyStore: {
        verify: vi.fn(async () => ({ id: 5, userId: 1, scopes: ['admin'] })),
        touchLastUsed: vi.fn(async () => {}),
        create: vi.fn(async () => row()),
      } as never,
    })
    const res = await app.request('/api/v1/api-keys', {
      method: 'POST',
      headers: { Authorization: 'Bearer dgr_ab12cd34_secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'escalate', scopes: ['admin'] }),
    })
    expect(res.status).toBe(403)
  })
})

describe('GET /api/v1/api-keys', () => {
  it('scopes the listing to the caller', async () => {
    const listForUser = vi.fn(async () => [row()])
    const { app } = createTestApp({ apiKeyStore: { listForUser } as never })
    const res = await app.request('/api/v1/api-keys', { headers: AUTH })
    expect(res.status).toBe(200)
    expect(listForUser).toHaveBeenCalledWith(1)
  })

  it('never includes a hash', async () => {
    const { app } = createTestApp({
      apiKeyStore: { listForUser: vi.fn(async () => [row()]) } as never,
    })
    const raw = await (await app.request('/api/v1/api-keys', { headers: AUTH })).text()
    expect(raw).not.toContain('keyHash')
    expect(raw).not.toContain('key_hash')
  })
})

describe('DELETE /api/v1/api-keys/:id', () => {
  it('revokes the caller\'s own key', async () => {
    const revoke = vi.fn(async () => true)
    const { app } = createTestApp({ apiKeyStore: { revoke } as never })
    const res = await app.request('/api/v1/api-keys/10', { method: 'DELETE', headers: AUTH })
    expect(res.status).toBe(204)
    expect(revoke).toHaveBeenCalledWith({ id: 10, userId: 1 })
  })

  it('reports 404, not 403, for a key belonging to someone else', async () => {
    const { app } = createTestApp({
      apiKeyStore: { revoke: vi.fn(async () => false) } as never,
    })
    const res = await app.request('/api/v1/api-keys/10', { method: 'DELETE', headers: AUTH })
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd ~/Projects/digarr && bun run test tests/api-routes/api-keys.test.ts
```

Expected: FAIL — routes return 404.

- [ ] **Step 3: Write the validation schema**

Create `src/server/schemas/api-keys.ts`:

```ts
import * as z from 'zod'
import { API_KEY_SCOPES } from '@/core/auth/api-keys'
import { stripControlChars } from '@/core/text/strip-control-chars'
import { idParamSchema } from './validator'

export const apiKeyIdParamSchema = idParamSchema

export const createApiKeySchema = z.object({
  name: z
    .string()
    .transform((s) => stripControlChars(s).trim())
    .pipe(z.string().min(1).max(100)),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).max(API_KEY_SCOPES.length),
  expiresAt: z.iso.datetime().nullish(),
})
```

If `z.iso.datetime()` is not the spelling this Zod version uses, match whatever other schema files in `src/server/schemas/` use for timestamps.

- [ ] **Step 4: Write the routes**

Create `src/server/routes/api-keys.ts`:

```ts
import { Hono } from 'hono'
import { generateApiKey, parseScopes } from '@/core/auth/api-keys'
import type { ApiKeyStore } from '@/db/queries/api-keys'
import { problem } from '@/server/helpers/problem'
import { requireSessionUser } from '@/server/helpers/require-user'
import { apiKeyIdParamSchema, createApiKeySchema } from '@/server/schemas/api-keys'
import { zJson, zParam } from '@/server/schemas/validator'
import type { HonoEnv } from '@/server/types'

export type ApiKeyRouteDeps = {
  apiKeyStore: ApiKeyStore
}

export function apiKeyRoutes(deps: ApiKeyRouteDeps) {
  const router = new Hono<HonoEnv>()

  // Session auth only, on every route below. An API key must never be able to
  // mint, list or revoke an API key -- that would make any leaked key
  // self-perpetuating and let a `write` key escalate itself to `admin`.

  router.get('/api/v1/api-keys', async (c) => {
    const auth = requireSessionUser(c)
    if (!auth.ok) return auth.response
    return c.json({ items: await deps.apiKeyStore.listForUser(auth.userId) })
  })

  router.post('/api/v1/api-keys', zJson(createApiKeySchema), async (c) => {
    const auth = requireSessionUser(c)
    if (!auth.ok) return auth.response
    const { name, scopes, expiresAt } = c.req.valid('json')

    const { token, prefix, keyHash } = generateApiKey()
    const key = await deps.apiKeyStore.create({
      userId: auth.userId,
      name,
      prefix,
      keyHash,
      scopes: parseScopes(scopes),
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    })

    // The only time the plaintext is ever returned. It is not recoverable
    // afterwards -- only its SHA-256 digest is stored.
    return c.json({ key, token }, 201)
  })

  router.delete('/api/v1/api-keys/:id', zParam(apiKeyIdParamSchema), async (c) => {
    const auth = requireSessionUser(c)
    if (!auth.ok) return auth.response
    const { id } = c.req.valid('param')
    const revoked = await deps.apiKeyStore.revoke({ id, userId: auth.userId })
    if (!revoked) {
      // 404 rather than 403: a key belonging to someone else must not be
      // distinguishable from one that does not exist.
      return problem(c, 'not-found', 'API key not found', 404)
    }
    return c.body(null, 204)
  })

  return router
}
```

- [ ] **Step 5: Wire the deps**

In `src/server/deps.ts`, add a slice and include it in the `AppDependencies` intersection at `:270`:

```ts
export interface ApiKeyDeps {
  apiKeyStore: ApiKeyStore
}
```

In `src/server/index.ts`, mount alongside the other routers (`:298-310`) and feed the same store to the guard:

```ts
  app.route('/', apiKeyRoutes(deps))
```

and where `authGuard({ ... })` is constructed in that file, add `apiKeys: deps.apiKeyStore` to its options — this is what activates the Task 3 branch in the real app.

In `src/index.ts`, near `setSessionStore(sessionQueries(db))` at `:247`, build the store once:

```ts
const apiKeyStore = apiKeyQueries(db)
```

and pass `apiKeyStore` into the deps object handed to `createApp`.

- [ ] **Step 6: Document the routes**

`bun run check:api-docs` requires one markdown table row per route. Add to `docs/API.md`, in the section style already used there:

```markdown
| GET | `/api/v1/api-keys` | List your own API keys. Never returns secrets. |
| POST | `/api/v1/api-keys` | Create an API key. Returns the plaintext token once. |
| DELETE | `/api/v1/api-keys/:id` | Revoke one of your own API keys. |
```

Also add an "API keys" section to `docs/AUTHENTICATION.md` covering: the `dgr_` token format, `Authorization: Bearer` only (never `?token=`), the three ordered scopes, that scopes narrow and never grant, that key management is session-only, and that revocation is immediate.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd ~/Projects/digarr && bun run test tests/api-routes/api-keys.test.ts && bun run check:api-docs && bun run typecheck && bun run lint
```

Expected: tests PASS, api-docs check PASSes.

- [ ] **Step 8: Commit**

```bash
cd ~/Projects/digarr
git add src/server/routes/api-keys.ts src/server/schemas/api-keys.ts src/server/deps.ts src/server/index.ts src/index.ts docs/API.md docs/AUTHENTICATION.md tests/api-routes/api-keys.test.ts
git commit -m "feat(api): add session-only API key management routes"
```

---

### Task 6: Unapprove — reverse an approval, including the Lidarr add

**Files:**
- Modify: `src/core/clients/lidarr.ts` (add `removeArtist`, near `addArtist` at `:196`)
- Modify: `src/server/routes/recommendations.ts` (handle the revert branch in the existing `PATCH`)
- Test: `tests/core/lidarr-remove-artist.test.ts`, `tests/api-routes/recommendations-unapprove.test.ts`

**Interfaces:**
- Consumes: the existing Lidarr client factory and `recommendations.lidarrArtistId`.
- Produces: `removeArtist(artistId: number, options: { deleteFiles: boolean }): Promise<void>` on the Lidarr client. `PATCH /api/v1/recommendations/:id` with `{ status: 'pending' }` reverts the row and returns `{ status: 'pending', lidarrArtistRemoved: boolean, lidarrRemovalSkippedReason?: string }`.

Note `recommendationStatusSchema` already accepts `'pending'` (`src/server/schemas/recommendations.ts:12`) and only `status === 'approved'` fires the target chain, so reverting the row itself needs no schema change.

- [ ] **Step 1: Write the failing test for the client**

Create `tests/core/lidarr-remove-artist.test.ts`:

```ts
// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLidarrClient } from '@/core/clients/lidarr'

afterEach(() => vi.unstubAllGlobals())

describe('removeArtist', () => {
  it('issues a DELETE that does not delete files by default', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const client = createLidarrClient({ url: 'http://lidarr', apiKey: 'k' })
    await client.removeArtist(42, { deleteFiles: false })

    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(String(url)).toContain('/api/v1/artist/42')
    expect(String(url)).toContain('deleteFiles=false')
    expect((init as RequestInit | undefined)?.method).toBe('DELETE')
  })

  it('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    const client = createLidarrClient({ url: 'http://lidarr', apiKey: 'k' })
    await expect(client.removeArtist(42, { deleteFiles: false })).rejects.toThrow()
  })
})
```

Adjust `createLidarrClient` to the factory's real exported name and argument shape — read the top of `src/core/clients/lidarr.ts` first.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd ~/Projects/digarr && bun run test tests/core/lidarr-remove-artist.test.ts
```

Expected: FAIL — `removeArtist` is not a function.

- [ ] **Step 3: Implement removeArtist**

In `src/core/clients/lidarr.ts`, beside `addArtist` (`:196`), following the exact request/error helpers the neighbouring methods use:

```ts
  /**
   * Remove an artist from Lidarr. Used to reverse an approval digarr made.
   * `deleteFiles` is false in every current caller: undo should unwind the
   * monitoring decision, never destroy media already on disk.
   */
  async function removeArtist(
    artistId: number,
    options: { deleteFiles: boolean },
  ): Promise<void> {
    await request(
      `/api/v1/artist/${artistId}?deleteFiles=${options.deleteFiles}&addImportListExclusion=false`,
      { method: 'DELETE' },
    )
  }
```

Add `removeArtist` to the object the factory returns.

- [ ] **Step 4: Run it to verify it passes**

```bash
cd ~/Projects/digarr && bun run test tests/core/lidarr-remove-artist.test.ts
```

- [ ] **Step 5: Write the failing route test**

Create `tests/api-routes/recommendations-unapprove.test.ts`, using the same `createTestApp` harness and `@/core/sessions` mock as `tests/api-routes/recommendations.test.ts`, and `makeRecommendation` from `tests/helpers/factories.ts`:

```ts
// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { makeRecommendation } from '../helpers/factories'
import { createTestApp } from '../helpers/test-app'

vi.mock('@/core/sessions', () => ({
  getSession: vi.fn().mockResolvedValue({
    userId: 1,
    token: 'tok',
    expiresAt: new Date(Date.now() + 86400000),
  }),
}))

const AUTH = { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }

function patchPending(app: ReturnType<typeof createTestApp>['app'], id: number) {
  return app.request(`/api/v1/recommendations/${id}`, {
    method: 'PATCH',
    headers: AUTH,
    body: JSON.stringify({ status: 'pending' }),
  })
}

describe('PATCH /api/v1/recommendations/:id with status=pending', () => {
  it('reverts the row and removes the Lidarr artist digarr added', async () => {
    const removeArtist = vi.fn(async () => {})
    const { app } = createTestApp({
      getRecommendation: vi.fn(async () =>
        makeRecommendation({ id: 1, userId: 1, status: 'approved', lidarrArtistId: 42 }),
      ) as never,
      lidarrRemoveArtist: removeArtist,
      lidarrArtistHasFiles: vi.fn(async () => false),
    } as never)
    const res = await patchPending(app, 1)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'pending', lidarrArtistRemoved: true })
    expect(removeArtist).toHaveBeenCalledWith(42, { deleteFiles: false })
  })

  it('reverts but keeps the artist when files already downloaded', async () => {
    const removeArtist = vi.fn(async () => {})
    const { app } = createTestApp({
      getRecommendation: vi.fn(async () =>
        makeRecommendation({ id: 1, userId: 1, status: 'approved', lidarrArtistId: 42 }),
      ) as never,
      lidarrRemoveArtist: removeArtist,
      lidarrArtistHasFiles: vi.fn(async () => true),
    } as never)
    const res = await patchPending(app, 1)
    expect(await res.json()).toMatchObject({
      status: 'pending',
      lidarrArtistRemoved: false,
      lidarrRemovalSkippedReason: 'has_files',
    })
    expect(removeArtist).not.toHaveBeenCalled()
  })

  it('reverts but keeps nothing to remove when digarr never added the artist', async () => {
    const removeArtist = vi.fn(async () => {})
    const { app } = createTestApp({
      getRecommendation: vi.fn(async () =>
        makeRecommendation({ id: 1, userId: 1, status: 'approved', lidarrArtistId: null }),
      ) as never,
      lidarrRemoveArtist: removeArtist,
    } as never)
    const res = await patchPending(app, 1)
    expect(await res.json()).toMatchObject({
      status: 'pending',
      lidarrArtistRemoved: false,
      lidarrRemovalSkippedReason: 'not_added_by_digarr',
    })
    expect(removeArtist).not.toHaveBeenCalled()
  })

  it('still reverts the row when the Lidarr removal fails', async () => {
    const { app } = createTestApp({
      getRecommendation: vi.fn(async () =>
        makeRecommendation({ id: 1, userId: 1, status: 'approved', lidarrArtistId: 42 }),
      ) as never,
      lidarrRemoveArtist: vi.fn(async () => {
        throw new Error('lidarr down')
      }),
      lidarrArtistHasFiles: vi.fn(async () => false),
    } as never)
    const res = await patchPending(app, 1)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      status: 'pending',
      lidarrArtistRemoved: false,
      lidarrRemovalSkippedReason: 'removal_failed',
    })
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

```bash
cd ~/Projects/digarr && bun run test tests/api-routes/recommendations-unapprove.test.ts
```

- [ ] **Step 7: Implement the revert branch**

In `src/server/routes/recommendations.ts`, inside the `PATCH` handler, add a branch for `status === 'pending'` that mirrors how the `approved` branch loads and authorises the row (`loadOwnedRecommendation`). It must:

1. Load the owned recommendation; 404 if absent.
2. Set `status = 'pending'`, clear `actedOnAt`, `lidarrError` and `targetActions`.
3. Attempt Lidarr removal only when `lidarrArtistId` is set **and** the artist has no files. Skip reasons are `not_added_by_digarr`, `has_files`, `removal_failed`.
4. Clear `lidarrArtistId` only when removal actually succeeded — otherwise the row would forget an artist that still exists.
5. Never fail the revert because Lidarr failed. Reverting the row is the user's explicit instruction; the Lidarr outcome is reported, not enforced.

Add the two new deps (`lidarrRemoveArtist`, `lidarrArtistHasFiles`) to the `RecommendationDeps` slice in `src/server/deps.ts` and wire them in `src/index.ts` from the Lidarr client for the recommendation's owning user's target.

- [ ] **Step 8: Run the tests to verify they pass**

```bash
cd ~/Projects/digarr && bun run test tests/api-routes/ tests/core/ && bun run check:api-docs && bun run typecheck && bun run lint
```

The `PATCH` route already exists in `docs/API.md`, so `check:api-docs` needs no new row — but update that row's description to mention the revert behaviour.

- [ ] **Step 9: Commit**

```bash
cd ~/Projects/digarr
git add src/core/clients/lidarr.ts src/server/routes/recommendations.ts src/server/deps.ts src/index.ts docs/API.md tests/core/lidarr-remove-artist.test.ts tests/api-routes/recommendations-unapprove.test.ts
git commit -m "feat(recommendations): reverse an approval, removing the Lidarr artist digarr added

Guarded on digarr having made the add and on no files having downloaded.
The row always reverts; a failed Lidarr removal is reported, never fatal."
```

---

### Task 7: Account-tab UI and translations

**Files:**
- Create: `src/web/components/api-keys-card.tsx`
- Modify: `src/web/pages/settings.tsx` (mount in the Account tab; the tab is declared at `:158`)
- Modify: `src/core/i18n/messages/en.ts` and all 14 other catalogs
- Test: `tests/web/components/api-keys-card.test.tsx`

**Interfaces:**
- Consumes: the routes from Task 5 and `API_KEY_SCOPES` from Task 1.
- Produces: `<ApiKeysCard />`, self-contained; it fetches its own data through the shared `src/web/lib/api.ts` client.

`settings.tsx` is **3,983 lines**. The card goes in its own file and the mount is a few lines. Do not move unrelated code into or out of `settings.tsx` as part of this task.

- [ ] **Step 1: Write the failing test**

Create `tests/web/components/api-keys-card.test.tsx`, following the real pattern used by the existing tests in `tests/web/components/` — jsdom, the `I18nProvider` / `QueryClientProvider` / `MemoryRouter` wrappers, and a **module mock of `@/web/lib/api`** rather than a global `fetch` stub. Compare against `tests/web/components/approve-dialog.test.tsx:1-25`.

This task also adds three client functions to `src/web/lib/api.ts`, matching the `export async function` style used there: `listApiKeys()`, `createApiKey(body)`, `revokeApiKey(id)`.

```tsx
// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/web/lib/i18n'

vi.mock('@/web/lib/locale-storage', () => ({
  detectBrowserLocale: vi.fn(() => 'en'),
  getStoredLocale: vi.fn(() => 'en'),
  setStoredLocale: vi.fn(),
}))

vi.mock('@/web/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/web/lib/api')>()
  return {
    ...actual,
    listApiKeys: vi.fn(),
    createApiKey: vi.fn(),
    revokeApiKey: vi.fn(),
  }
})

import { ApiKeysCard } from '@/web/components/api-keys-card'
import { createApiKey, listApiKeys } from '@/web/lib/api'

function renderCard(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <I18nProvider>{ui}</I18nProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

const KEY = {
  id: 1,
  userId: 1,
  name: 'Music Assistant',
  prefix: 'ab12cd34',
  scopes: ['read', 'write'],
  createdAt: new Date().toISOString(),
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
}

beforeEach(() => {
  vi.mocked(listApiKeys).mockResolvedValue({ items: [KEY] } as never)
})

describe('ApiKeysCard', () => {
  it('lists existing keys with their prefix', async () => {
    renderCard(<ApiKeysCard />)
    expect(await screen.findByText('Music Assistant')).toBeInTheDocument()
    expect(screen.getByText(/ab12cd34/)).toBeInTheDocument()
  })

  it('shows an empty state when the user has no keys', async () => {
    vi.mocked(listApiKeys).mockResolvedValue({ items: [] } as never)
    renderCard(<ApiKeysCard />)
    expect(await screen.findByText(/no api keys/i)).toBeInTheDocument()
  })

  it('reveals the created token once, with a warning that it will not reappear', async () => {
    const token = 'dgr_ab12cd34_secretsecretsecret'
    vi.mocked(createApiKey).mockResolvedValue({ key: { ...KEY, id: 2 }, token } as never)
    renderCard(<ApiKeysCard />)

    await userEvent.click(await screen.findByRole('button', { name: /create/i }))
    await userEvent.type(screen.getByLabelText(/name/i), 'new key')
    await userEvent.click(screen.getByRole('button', { name: /^create$/i }))

    await waitFor(() => expect(screen.getByText(token)).toBeInTheDocument())
    expect(screen.getByText(/not be shown again|won't be shown again/i)).toBeInTheDocument()
  })

  it('never renders a revoked key as usable', async () => {
    vi.mocked(listApiKeys).mockResolvedValue({
      items: [{ ...KEY, revokedAt: new Date().toISOString() }],
    } as never)
    renderCard(<ApiKeysCard />)
    expect(await screen.findByText(/revoked/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd ~/Projects/digarr && bun run test tests/web/components/api-keys-card.test.tsx
```

Expected: FAIL — the component does not exist.

- [ ] **Step 3: Build the component**

Create `src/web/components/api-keys-card.tsx`, following the structure of the existing `NotificationChannelsCard` (`src/web/pages/settings.tsx:553`) for card layout, save-state handling and toast usage, and using the existing `confirm-dialog` component for revoke. It must render:

- a table of name / prefix / scopes / created / last used, with a Revoke action per row
- a create form with a name field and a checkbox per entry in `API_KEY_SCOPES`
- after creation, the plaintext token in a copyable block with an explicit "this won't be shown again" warning
- an empty state when the user has no keys

Every user-visible string goes through the existing `t(...)` helper — no literals.

- [ ] **Step 4: Mount it in the Account tab**

In `src/web/pages/settings.tsx`, render `<ApiKeysCard />` within the Account tab panel (tab id `account`, declared at `:158`).

- [ ] **Step 5: Add English strings, then translate**

Add the new keys to `src/core/i18n/messages/en.ts` under an `apiKeys.*` prefix, matching the flat dotted-key style used throughout that file. Then generate the other 14 catalogs:

```bash
cd ~/Projects/digarr
export TRANSLATION_BASE_URL=... TRANSLATION_API_KEY=... TRANSLATION_MODEL=...
for locale in de es fr it ja ko nl pl pt-BR ro ru tr uk zh-CN; do
  bun scripts/i18n-machine-translate.ts "$locale" --write
done
bun run i18n:check
```

`i18n:check` rejects any value that merely equals the English source unless it is an allowlisted technical term, so read its output and hand-fix what it flags.

- [ ] **Step 6: Run everything**

```bash
cd ~/Projects/digarr && bun run test && bun run i18n:check && bun run typecheck && bun run lint
```

Compare the failure count against the Task 0 baseline. Expected: no new failures.

- [ ] **Step 7: Commit**

```bash
cd ~/Projects/digarr
git add src/web/components/api-keys-card.tsx src/web/pages/settings.tsx src/core/i18n/messages/ tests/web/components/api-keys-card.test.tsx
git commit -m "feat(web): self-service API key management in the Account tab"
```

---

### Task 8: Build, deploy, and verify on .101

**Files:** none in the repo. This task produces a running image and a real key.

- [ ] **Step 1: Full verification before building**

```bash
cd ~/Projects/digarr
bun run test && bun run typecheck && bun run lint && bun run i18n:check && bun run check:api-docs
```

Compare against the Task 0 baseline. Do not proceed with new failures.

- [ ] **Step 2: Snapshot the database**

```bash
ssh root@10.0.0.101 -i ~/.ssh/id_ed25519 \
  'zfs snapshot Fast/pgdata-media-server@pre-apikeys-'"$(date +%Y%m%d-%H%M)"
```

- [ ] **Step 3: Sync the source to the build host and build**

`.101` builds from `/mnt/Fast/docker/build/digarr`. Sync this branch there, then:

```bash
ssh root@10.0.0.101 -i ~/.ssh/id_ed25519 \
  'cd /mnt/Fast/docker/build/digarr && docker build -t tomvaisbort/digarr:1.15.1-r7 .'
```

- [ ] **Step 4: Relay the image and push**

`.101`'s Docker Hub token is read-only and `.101` cannot ssh to `.120`, so the exact image is relayed through the Mac rather than rebuilt:

```bash
ssh root@10.0.0.101 -i ~/.ssh/id_ed25519 'docker save tomvaisbort/digarr:1.15.1-r7 | gzip -1' \
  | ssh tom@10.0.0.120 'gunzip | docker load'
ssh root@10.0.0.101 -i ~/.ssh/id_ed25519 'docker inspect --format "{{.Id}}" tomvaisbort/digarr:1.15.1-r7'
ssh tom@10.0.0.120 'docker inspect --format "{{.Id}}" tomvaisbort/digarr:1.15.1-r7'
```

The two ids must match. Then:

```bash
ssh tom@10.0.0.120 'docker push tomvaisbort/digarr:1.15.1-r7'
```

- [ ] **Step 5: Deploy and confirm the migration ran**

Edit the `image:` line for the `digarr` service in `/mnt/Fast/docker/stacks/media-server/compose.yaml` on `.101`, then:

```bash
ssh root@10.0.0.101 -i ~/.ssh/id_ed25519 \
  'cd /mnt/Fast/docker/stacks/media-server && docker compose up -d digarr && sleep 15 && docker logs --tail 40 media-server-digarr-1'
ssh root@10.0.0.101 -i ~/.ssh/id_ed25519 \
  'docker exec media-server-postgres-db-1 psql -U postgres -d digarr -c "\d api_keys"'
```

Expected: the table exists with the `api_keys_prefix_unique` index.

- [ ] **Step 6: Mint a key and verify the scope matrix end to end**

Sign in to `https://digarr.leratom.cloud`, open Settings → Account, and create a key named `Music Assistant` with `read` and `write`. Then, from a host that can reach `.109`:

```bash
KEY='dgr_...'
# read: expect 200 with items
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $KEY" \
  'http://10.0.0.109:3000/api/v1/recommendations?status=pending&limit=1'
# admin route with a non-admin key: expect 403
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $KEY" \
  'http://10.0.0.109:3000/api/v1/jobs'
# key management with a key: expect 403
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $KEY" \
  'http://10.0.0.109:3000/api/v1/api-keys'
# query-param auth: expect 401
curl -s -o /dev/null -w '%{http_code}\n' \
  "http://10.0.0.109:3000/api/v1/recommendations?token=$KEY"
```

All four must match the stated expectations. The third is the escalation guard from Task 4 — if it returns 200, stop and fix before going further.

- [ ] **Step 7: Record the outcome**

Note the image digest, the deployed tag, and the key prefix (not the secret) in the deploy notes. Rollback is flipping the `image:` line back to `1.15.1-r6`; the old image remains on the box, and digarr is excluded from the 04:00 watchtower sweep so the pin holds.

Leave the key secret somewhere Part 2 can reach it — it is unrecoverable after the dialog closes.

---

## Self-Review

**Spec coverage.** Schema and hashing → Task 2. Reserved migration range → Task 2 Step 4. Scopes → Task 1. Middleware branch, throttled last-used, no query-param keys → Task 3. `csrfGuard`, `adminGuard`/`resolveAdmin`, `requireSessionUser`, `scopeGuard` → Task 4. Routes, session-only management, docs → Task 5. Unapprove and `removeArtist` → Task 6. Account-tab UI and enforced i18n → Task 7. Deploy and the scope matrix → Task 8. Test baselining → Task 0 and repeated in Tasks 7 and 8.

**Type consistency.** `generateApiKey`, `parseApiKey`, `hashApiKeySecret`, `isApiKeyToken`, `scopeSatisfies`, `parseScopes`, `API_KEY_SCOPES` are defined in Task 1 and used with those exact names in Tasks 2, 3, 4 and 5. `apiKeyQueries` returns `create` / `verify` / `listForUser` / `listAll` / `revoke` / `touchLastUsed`; Task 3 uses `verify` and `touchLastUsed`, Task 5 uses `create`, `listForUser` and `revoke`. `ApiKeyRow` never carries `keyHash`, which is what the Task 5 leak tests assert. `API_KEY_TOUCH_THROTTLE_MS` is defined in Task 2 and consumed in Task 3.

**Harnesses verified.** The three test harnesses are real and named correctly: `makeTestDb()` from `tests/helpers/test-db.ts`, `createTestApp()` / `makeDeps()` from `tests/helpers/test-app.ts`, and `makeRecommendation()` from `tests/helpers/factories.ts`. There are no `sessionHeaders`-style helpers — api-route tests authenticate by mocking `@/core/sessions` and sending `Authorization: Bearer tok`. `createLidarrClient` is the real export from `src/core/clients/lidarr.ts:81`. `problem()` takes **status as its fourth argument** (`src/server/helpers/problem.ts:21`), which every call in this plan follows.

**Also update `tests/helpers/test-app.ts`** in Task 5 Step 1: `makeDeps` returns a full `AppDependencies`, so adding the required `apiKeyStore` field there is what keeps every pre-existing api-route test compiling.
