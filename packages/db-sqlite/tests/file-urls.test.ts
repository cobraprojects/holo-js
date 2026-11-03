import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteDatabaseDriverFactory } from '../src'

describe('SQLite file: URLs', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'holo-sqlite-file-url-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it.each([
    { form: 'file:/absolute/path', url: (root: string) => `file:${root}/nested/my%20data.sqlite` },
    { form: 'file:///absolute/path', url: (root: string) => `file://${root}/nested/my%20data.sqlite` },
    { form: 'file://localhost/absolute/path', url: (root: string) => `file://localhost${root}/nested/my%20data.sqlite` },
  ])('creates and opens the database at the path of a $form URL', async ({ url }) => {
    const adapter = sqliteDatabaseDriverFactory.create({ url: url(directory) })
    try {
      await expect(adapter.databaseExists?.()).resolves.toBe(false)
      await adapter.ensureDatabaseExists?.()
      await adapter.execute('CREATE TABLE records (id INTEGER PRIMARY KEY)')

      expect(existsSync(join(directory, 'nested/my data.sqlite'))).toBe(true)
      expect(await readdir(directory)).toEqual(['nested'])
      await expect(adapter.databaseExists?.()).resolves.toBe(true)
    } finally {
      await adapter.disconnect()
    }
  })

  it('names the path of a missing file: URL database without creating it', async () => {
    const filename = join(directory, 'missing.sqlite')
    const adapter = sqliteDatabaseDriverFactory.create({ url: `file:${filename}` })

    await expect(adapter.query('SELECT 1')).rejects.toThrow(`Database file at path "${filename}" does not exist.`)
    expect(await readdir(directory)).toEqual([])
  })

  it('opens an in-memory database for file::memory:', async () => {
    const adapter = sqliteDatabaseDriverFactory.create({ url: 'file::memory:' })
    try {
      await expect(adapter.databaseExists?.()).resolves.toBe(true)
      await adapter.execute('CREATE TABLE records (id INTEGER PRIMARY KEY)')
      await adapter.execute('INSERT INTO records (id) VALUES (1)')

      expect((await adapter.query('SELECT id FROM records')).rows).toEqual([{ id: 1 }])
    } finally {
      await adapter.disconnect()
    }
  })

  it('rejects a file: URL with query parameters instead of ignoring them', () => {
    expect(() => sqliteDatabaseDriverFactory.create({ url: `file:${directory}/data.sqlite?mode=ro` }))
      .toThrow(`SQLite URL "file:${directory}/data.sqlite?mode=ro" has query parameters, which Holo doesn't support. Remove "?mode=ro" from the URL.`)
  })
})
