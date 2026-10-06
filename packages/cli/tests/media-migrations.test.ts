import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase, createDialect, createSchemaService, type MigrationDefinition } from '@holo-js/db'
import { createSQLiteAdapter } from '../../db-sqlite/src'
import { expect, it } from 'vitest'
import { renderMediaTableMigration } from '../src/media-migrations'
import { importProjectModule } from '../src/project/runtime'

it('generates a media migration with indexes for path and file lookups', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'holo-media-migration-'))
  const adapter = createSQLiteAdapter({})
  const db = createDatabase({ adapter, dialect: createDialect('sqlite') })
  const schema = createSchemaService(db)

  try {
    const migrationPath = join(projectRoot, 'media.ts')
    await writeFile(migrationPath, renderMediaTableMigration())
    const { default: migration } = await importProjectModule(projectRoot, migrationPath) as { default: MigrationDefinition }
    await migration.up({ db, schema })

    expect(await schema.getIndexes('media')).toEqual(expect.arrayContaining([
      expect.objectContaining({ columns: ['path'], unique: false }),
      expect.objectContaining({ columns: ['file_name', 'mime_type'], unique: false }),
    ]))
  } finally {
    await adapter.disconnect()
    await rm(projectRoot, { recursive: true, force: true })
  }
})
