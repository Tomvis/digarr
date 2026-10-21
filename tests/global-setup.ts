import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  export interface ProvidedContext {
    migratedDbTar: string
  }
}

// Migrate once per run; makeTestDb() starts each in-memory DB from this dump
// instead of replaying every migration (MUSIC-167).
export default async function setup(project: TestProject) {
  const client = new PGlite()
  await migrate(drizzle(client), { migrationsFolder: './drizzle' })
  const dump = await client.dumpDataDir('none')
  await client.close()
  const dir = await mkdtemp(join(tmpdir(), 'digarr-testdb-'))
  const file = join(dir, 'migrated.tar')
  await writeFile(file, Buffer.from(await dump.arrayBuffer()))
  project.provide('migratedDbTar', file)
  return () => rm(dir, { recursive: true, force: true })
}
