import { mkdir, open, readFile, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { transform } from 'esbuild'
import { inferMigrationTableName, inferMigrationTemplateKind, normalizeMigrationSlug } from '@holo-js/db'
import { ensureProjectConfig, loadGeneratedProjectRegistry, makeProjectRelativePath, prepareProjectDiscovery } from './project'
import { collectFiles } from './project/discovery-helpers'
import { getRegistryMigrationSlug, hasRegisteredCreateTableMigration, MIGRATION_NAME_PREFIX_PATTERN, nextMigrationTemplate } from './migrations'
import { writeLine } from './io'
import type { IoStreams } from './cli-types'

type MigrationCreation = {
  readonly name: string
  readonly tableNames?: readonly string[]
  readonly templateOptions?: Parameters<typeof nextMigrationTemplate>[2]
  readonly contents?: string
  readonly conflictMessage?: string
  readonly skipIfExists?: boolean
}

async function withMigrationCreationLock<TResult>(projectRoot: string, callback: () => Promise<TResult>): Promise<TResult> {
  const lockPath = join(projectRoot, '.holo-js/migration-create.lock')
  await mkdir(dirname(lockPath), { recursive: true })
  const started = Date.now()
  while (true) {
    try {
      await mkdir(lockPath)
      break
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      if (Date.now() - started >= 30_000) throw new Error('Timed out waiting for another migration creation command to finish.')
      await wait(10)
    }
  }
  try {
    return await callback()
  } finally {
    await rm(lockPath, { recursive: true, force: true })
  }
}

async function createdTableNames(path: string): Promise<string[]> {
  const source = await transform(await readFile(path, 'utf8'), { loader: 'ts', minifyWhitespace: true, legalComments: 'none' })
  const tokens = source.code.match(/"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g) ?? []
  const names: string[] = []
  for (const [position, token] of tokens.entries()) {
    const literal = tokens[position + 3]
    if (token !== '.' || tokens[position + 1] !== 'createTable' || tokens[position + 2] !== '(' || !literal?.startsWith('"')) continue
    const name: unknown = JSON.parse(literal)
    if (typeof name === 'string') names.push(name)
  }
  return names
}

export async function createMigrationFiles(
  projectRoot: string,
  plan: (project: Awaited<ReturnType<typeof ensureProjectConfig>>) => readonly MigrationCreation[] | Promise<readonly MigrationCreation[]>,
  options: { readonly io?: IoStreams, readonly prepare?: boolean } = {},
): Promise<string[]> {
  const root = await realpath(projectRoot)
  return withMigrationCreationLock(root, async () => {
    const project = await ensureProjectConfig(root)
    const registry = await loadGeneratedProjectRegistry(root) ?? await prepareProjectDiscovery(root, project.config)
    const migrationsDir = resolve(root, project.config.paths.migrations)
    const files = (await collectFiles(migrationsDir)).filter(path => MIGRATION_NAME_PREFIX_PATTERN.test(basename(path)))
    const slugs = new Set(registry?.migrations.map(entry => getRegistryMigrationSlug(entry.name)))
    const tables = new Set<string>()
    const physicalTables = await Promise.all(files.map(createdTableNames))
    for (const [position, file] of files.entries()) {
      slugs.add(getRegistryMigrationSlug(basename(file).replace(/\.[^.]+$/, '')))
      for (const table of physicalTables[position] ?? []) tables.add(normalizeMigrationSlug(table))
    }
    const planned: Array<{ path: string, contents: string }> = []
    for (const entry of await plan(project)) {
      const slug = normalizeMigrationSlug(entry.name)
      const kind = entry.templateOptions?.kind ?? inferMigrationTemplateKind(slug)
      const inferred = entry.templateOptions?.tableName ?? inferMigrationTableName(slug, kind)
      const tableNames = entry.tableNames ?? (kind === 'create_table' && inferred ? [inferred] : [])
      const normalizedTables = tableNames.map(normalizeMigrationSlug)
      const duplicate = slugs.has(slug)
        || new Set(normalizedTables).size !== normalizedTables.length
        || tableNames.some((name, position) => tables.has(normalizedTables[position]!) || hasRegisteredCreateTableMigration(registry, name))
      if (duplicate) {
        if (entry.skipIfExists) continue
        throw new Error(entry.conflictMessage ?? (tableNames.length > 0
          ? `A migration for table "${tableNames[0]}" already exists.`
          : `A migration named "${slug}" already exists.`))
      }
      slugs.add(slug)
      for (const name of normalizedTables) tables.add(name)
      const template = await nextMigrationTemplate(slug, migrationsDir, entry.templateOptions)
      planned.push({ path: join(migrationsDir, template.fileName), contents: entry.contents ?? template.contents })
    }
    const owned: string[] = []
    try {
      await mkdir(migrationsDir, { recursive: true })
      for (const file of planned) {
        const handle = await open(file.path, 'wx')
        owned.push(file.path)
        try {
          await handle.writeFile(file.contents, 'utf8')
        } finally {
          await handle.close()
        }
      }
    } catch (error) {
      await Promise.all(owned.map(path => rm(path, { force: true })))
      throw error
    }
    if (options.io) {
      for (const path of owned) writeLine(options.io.stdout, `Created migration: ${makeProjectRelativePath(root, path)}`)
    }
    if (options.prepare && owned.length > 0) {
      const { runProjectPrepare } = await import('./dev')
      await runProjectPrepare(root)
    }
    return owned
  })
}
