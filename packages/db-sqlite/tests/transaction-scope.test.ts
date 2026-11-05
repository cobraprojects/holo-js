import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createSQLiteAdapter } from '../src'

function nextMacrotask(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

describe('SQLite transaction scopes on one file', () => {
  it('makes a task that outlives a scope on one adapter wait for a transaction that holds the file on another adapter', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holo-sqlite-scope-'))
    onTestFinished(() => rm(directory, { recursive: true, force: true }))
    const filename = join(directory, 'database.sqlite')
    await writeFile(filename, '')
    const first = createSQLiteAdapter({ filename })
    const second = createSQLiteAdapter({ filename })
    onTestFinished(async () => {
      await second.disconnect()
      await first.disconnect()
    })
    await first.execute('CREATE TABLE records (name TEXT NOT NULL)')
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    let fork!: Promise<unknown>

    await first.runWithTransactionScope(async () => {
      fork = released.then(() => second.execute('INSERT INTO records (name) VALUES (?)', ['fork']))
    })
    await second.runWithTransactionScope(async () => {
      await second.beginTransaction()
      await second.execute('INSERT INTO records (name) VALUES (?)', ['rolled back'])
      release()
      await nextMacrotask()
      await nextMacrotask()
      await second.rollback()
    })
    await fork

    expect((await first.query<{ name: string }>('SELECT name FROM records')).rows).toEqual([{ name: 'fork' }])
  }, 5_000)
})
