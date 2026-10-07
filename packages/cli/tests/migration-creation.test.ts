import '@holo-js/queue/config'
import type * as FsPromises from 'node:fs/promises'
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCacheTableCommand } from '../src/cache-migrations'
import { runQueueFailedTableCommand, runQueueTableCommand } from '../src/queue-migrations'
import { createMediaTableMigration, runMediaTableCommand } from '../src/media-migrations'
import { runMakeMigration } from '../src/generators'
import { ensureProjectConfig, prepareProjectDiscovery } from '../src/project'
import type { IoStreams } from '../src/cli-types'

const failure = vi.hoisted(() => ({ slug: '' }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      if (failure.slug && String(args[0]).endsWith(`_${failure.slug}.ts`)) {
        handle.writeFile = async () => {
          await handle.write('partial file')
          throw new Error('disk write failed')
        }
      }
      return handle
    },
  }
})

let root: string
let output: string
let io: IoStreams

async function write(relativePath: string, contents: string): Promise<void> {
  const path = join(root, relativePath)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
}

async function migrationFiles(): Promise<string[]> {
  return (await readdir(join(root, 'server/db/migrations')).catch(() => [] as string[])).filter(name => name.endsWith('.ts'))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holo-migration-creation-'))
  output = ''
  failure.slug = ''
  const stdout = new PassThrough()
  stdout.on('data', chunk => { output += String(chunk) })
  io = { cwd: root, stdin: process.stdin, stdout: stdout as unknown as NodeJS.WriteStream, stderr: process.stderr }
  await write('package.json', JSON.stringify({ name: 'fixture', private: true, type: 'module' }))
  await write('config/app.ts', 'export default {}\n')
  await write('config/database.ts', 'export default {}\n')
  await mkdir(join(root, 'node_modules/@holo-js'), { recursive: true })
  for (const name of await readdir(resolve(__dirname, '../../'))) {
    await symlink(resolve(__dirname, '../../', name), join(root, 'node_modules/@holo-js', name))
  }
  const project = await ensureProjectConfig(root)
  await prepareProjectDiscovery(root, project.config)
})

afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('migration creation commands', () => {
  it('refuses an on-disk duplicate hidden by stale discovery', async () => {
    await write('server/db/migrations/2026_01_01_000000_add_status.ts', 'export default { up() {} }\n')
    await expect(runMakeMigration(io, root, { args: ['add-status'], flags: {} })).rejects.toThrow('A migration named "add_status" already exists.')
    expect(await migrationFiles()).toEqual(['2026_01_01_000000_add_status.ts'])
  })
  it('refuses a table already created under a different on-disk migration name', async () => {
    await write('server/db/migrations/2026_01_01_000000_initial_schema.ts', "export default { up({ schema }) { schema.createTable('users', table => table.id()) } }\n")
    await expect(runMakeMigration(io, root, { args: ['create_user_accounts'], flags: { create: 'users' } })).rejects.toThrow('A migration for table "users" already exists.')
    expect(await migrationFiles()).toEqual(['2026_01_01_000000_initial_schema.ts'])
  })

  it('serializes concurrent attempts so exactly one creates the requested migration', async () => {
    const results = await Promise.allSettled([
      runMakeMigration(io, root, { args: ['create_users_table'], flags: {} }),
      runMakeMigration(io, root, { args: ['create_users_table'], flags: {} }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(await migrationFiles()).toHaveLength(1)
  })

  it('removes a partial file after writing fails and preserves existing migrations', async () => {
    await write('server/db/migrations/2026_01_01_000000_existing.ts', 'export default { up() {} }\n')
    failure.slug = 'failing_write'
    await expect(runMakeMigration(io, root, { args: ['failing_write'], flags: {} })).rejects.toThrow('disk write failed')
    expect(await migrationFiles()).toEqual(['2026_01_01_000000_existing.ts'])
    expect(output).not.toContain('Created migration:')
  })

  it('retains and reports completed files when project preparation fails', async () => {
    await write('server/db/migrations/2026_01_01_000000_existing.ts', "import missing from 'missing-migration-package'; export default missing\n")
    await expect(runMakeMigration(io, root, { args: ['create_users_table'], flags: {} })).rejects.toThrow()
    expect(await migrationFiles()).toHaveLength(2)
    expect(output).toContain('Created migration: server/db/migrations/')
    await expect(runMakeMigration(io, root, { args: ['create_users_table'], flags: {} })).rejects.toThrow('already exists')
    expect(await migrationFiles()).toHaveLength(2)
  })

  it('rejects a cache lock table hidden in an on-disk multi-table migration before writing a batch', async () => {
    await write('config/cache.ts', `export default {
      default: 'first', drivers: {
        first: { driver: 'database', table: 'new_entries', lockTable: 'new_locks' },
        second: { driver: 'database', table: 'other_entries', lockTable: 'existing_locks' },
      },
    }`)
    await write('server/db/migrations/2026_01_01_000000_initial_cache.ts', `export default { up({ schema }) {
      schema.createTable('existing_entries', table => table.id())
      schema.createTable('existing_locks', table => table.id())
    } }`)
    await expect(runCacheTableCommand(io, root)).rejects.toThrow('already exists')
    expect(await migrationFiles()).toEqual(['2026_01_01_000000_initial_cache.ts'])
  })

  it.each([
    { first: ['cache', 'cache'], second: undefined },
    { first: ['cache', 'locks'], second: ['locks', 'other_locks'] },
  ])('rejects overlapping cache physical tables before writing any migration: $first', async ({ first, second }) => {
    await write('config/cache.ts', `export default ${JSON.stringify({
      default: 'first', drivers: {
        first: { driver: 'database', table: first[0], lockTable: first[1] },
        ...(second ? { second: { driver: 'database', table: second[0], lockTable: second[1] } } : {}),
      },
    })}`)
    await expect(runCacheTableCommand(io, root)).rejects.toThrow('already exists')
    expect(await migrationFiles()).toEqual([])
  })

  it('checks the complete configured Queue batch against stale physical-table conflicts', async () => {
    await write('config/queue.ts', `export default { default: 'first', connections: {
      first: { driver: 'database', table: 'new_jobs' }, second: { driver: 'database', table: 'existing_jobs' },
    } }`)
    await write('server/db/migrations/2026_01_01_000000_initial_jobs.ts', "export default { up({ schema }) { schema.createTable('existing_jobs', table => table.id()) } }\n")
    await expect(runQueueTableCommand(io, root)).rejects.toThrow('A migration for table "existing_jobs" already exists.')
    expect(await migrationFiles()).toEqual(['2026_01_01_000000_initial_jobs.ts'])
  })

  it('refuses normalized Queue table-name collisions before writing', async () => {
    await write('config/queue.ts', `export default { default: 'first', connections: {
      first: { driver: 'database', table: 'tenant.jobs' }, second: { driver: 'database', table: 'tenant_jobs' },
    } }`)
    await expect(runQueueTableCommand(io, root)).rejects.toThrow('already exists')
    expect(await migrationFiles()).toEqual([])
  })

  it('cleans up every owned Queue file after a later batch write fails', async () => {
    await write('config/queue.ts', `export default { default: 'first', connections: {
      first: { driver: 'database', table: 'new_jobs' }, second: { driver: 'database', table: 'failing_jobs' },
    } }`)
    await write('server/db/migrations/2026_01_01_000000_existing.ts', 'export default { up() {} }\n')
    failure.slug = 'create_failing_jobs_table'
    await expect(runQueueTableCommand(io, root)).rejects.toThrow('disk write failed')
    expect(await migrationFiles()).toEqual(['2026_01_01_000000_existing.ts'])
    expect(output).not.toContain('Created migration:')
  })

  it('creates configured failed-job tables and refuses repeated creation', async () => {
    await write('config/queue.ts', "export default { failed: { driver: 'database', table: 'custom_failed_jobs' } }\n")
    await runQueueFailedTableCommand(io, root)
    expect(await migrationFiles()).toHaveLength(1)
    await expect(runQueueFailedTableCommand(io, root)).rejects.toThrow('A migration for table "custom_failed_jobs" already exists.')
    expect(output).toContain('Created migration:')
  })

  it('recognizes both tables from a completed Cache migration across command families', async () => {
    await write('config/cache.ts', `export default { default: 'database', drivers: {
      database: { driver: 'database', table: 'custom_cache', lockTable: 'custom_locks' },
    } }`)
    await runCacheTableCommand(io, root)
    await expect(runMakeMigration(io, root, { args: ['new_lock_migration'], flags: { create: 'custom_locks' } })).rejects.toThrow('A migration for table "custom_locks" already exists.')
    expect(await migrationFiles()).toHaveLength(1)
  })

  it('retains all completed Cache files and reports them when preparation fails', async () => {
    await write('config/cache.ts', `export default { default: 'first', drivers: {
      first: { driver: 'database', table: 'first_cache', lockTable: 'first_locks' },
      second: { driver: 'database', table: 'second_cache', lockTable: 'second_locks' },
    } }`)
    await write('server/db/migrations/2026_01_01_000000_existing.ts', "import missing from 'missing-migration-package'; export default missing\n")
    await expect(runCacheTableCommand(io, root)).rejects.toThrow()
    expect(await migrationFiles()).toHaveLength(3)
    expect(output.split('Created migration:')).toHaveLength(3)
    await expect(runCacheTableCommand(io, root)).rejects.toThrow('already exists')
    expect(await migrationFiles()).toHaveLength(3)
  })

  it('preserves Media skip-if-exists for a stale differently named physical-table migration', async () => {
    await write('server/db/migrations/2026_01_01_000000_initial_assets.ts', "export default { up({ schema }) { schema.createTable(`media`, table => table.id()) } }\n")
    expect(await createMediaTableMigration(root, { skipIfExists: true })).toBeUndefined()
    await expect(runMediaTableCommand(io, root)).rejects.toThrow('A migration for table "media" already exists.')
    expect(await migrationFiles()).toEqual(['2026_01_01_000000_initial_assets.ts'])
  })

  it('creates and reports a Media migration then skips repeated installation', async () => {
    await runMediaTableCommand(io, root)
    expect(output).toContain('Created migration:')
    expect(await createMediaTableMigration(root, { skipIfExists: true })).toBeUndefined()
    expect(await migrationFiles()).toHaveLength(1)
  })

  it('serializes competing command families creating the same physical table', async () => {
    const results = await Promise.allSettled([
      runQueueTableCommand(io, root),
      runMakeMigration(io, root, { args: ['new_queue_tables'], flags: { create: 'jobs' } }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(await migrationFiles()).toHaveLength(1)
  })

})
