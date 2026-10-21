import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { inject } from 'vitest'
import * as schema from '@/db/schema'

let template: Promise<Blob> | undefined

// In-memory DBs load the dump tests/global-setup.ts migrated once, so they all
// share one system_identifier; use a path when a test needs a distinct cluster.
// File-backed DBs always migrate, so reopening an existing dir works.
export async function makeTestDb(opts?: { path?: string }) {
  if (opts?.path) {
    const client = new PGlite(opts.path)
    const db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: './drizzle' })
    return { db, close: () => client.close() }
  }
  template ??= readFile(inject('migratedDbTar')).then((buf) => new Blob([buf]))
  const client = new PGlite({ loadDataDir: await template })
  const db = drizzle(client, { schema })
  return { db, close: () => client.close() }
}
