import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { unregisterDatabaseDriverFactory } from '@holo-js/db'
import { loadProjectDatabaseDrivers } from '../src/database-drivers'

const repoRoot = resolve(import.meta.dirname, '../../..')
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('project database driver loading', () => {
  it.each([
    ['mysql://user:password@localhost/runtime', 'mysql'],
    ['mysql2://user:password@localhost/runtime', 'mysql'],
    [':memory:', 'sqlite'],
  ])('loads the concrete driver for %s', async (databaseUrl, expectedDriver) => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'holo-cli-database-drivers-'))
    tempDirs.push(projectRoot)
    const mysqlPackagePath = join(projectRoot, 'node_modules/@holo-js/db-mysql')
    await mkdir(dirname(mysqlPackagePath), { recursive: true })
    await symlink(join(repoRoot, 'packages/db-mysql'), mysqlPackagePath)
    await symlink(
      join(repoRoot, 'packages/db-sqlite'),
      join(projectRoot, 'node_modules/@holo-js/db-sqlite'),
    )

    const factories = await loadProjectDatabaseDrivers(projectRoot, {
      connections: {
        main: databaseUrl,
      },
    })

    try {
      expect(factories.map(factory => factory.driver)).toEqual([expectedDriver])
    } finally {
      factories.forEach(unregisterDatabaseDriverFactory)
    }
  })
})
