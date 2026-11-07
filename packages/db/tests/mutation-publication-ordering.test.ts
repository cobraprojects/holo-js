import { describe, expect, it, onTestFinished } from 'vitest'
import { DB, clearGeneratedTables, column, configureDatabaseQueryCacheBridge, queryCacheInternals, registerGeneratedTables, resetDatabaseQueryCacheBridge, type DatabaseDependencyInvalidationEvent } from '../src'
import { defineTable } from './support/internal'
import { openDatabase } from './support/database'
import { createHeldPublicationBridge } from './support/held-publication'

type PublishedEvent = DatabaseDependencyInvalidationEvent & { readonly __holoDatabaseDependencyMetadata__?: { readonly unordered?: true } }

async function openItems() {
  const { adapter } = await openDatabase('sqlite')
  registerGeneratedTables({
    items: defineTable('items', { id: column.integer().primaryKey(), label: column.string() }),
    others: defineTable('others', { id: column.integer().primaryKey(), label: column.string() }),
    codes: defineTable('codes', { code: column.string().primaryKey(), label: column.string() }),
  })
  await adapter.execute('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)')
  await adapter.execute('CREATE TABLE others (id INTEGER PRIMARY KEY, label TEXT NOT NULL)')
  await adapter.execute('CREATE TABLE codes (code TEXT PRIMARY KEY, label TEXT NOT NULL)')
  await adapter.execute(`INSERT INTO items (id, label) VALUES (1, 'one'), (2, 'two')`)

  const { bridge, heldWrite } = createHeldPublicationBridge()
  configureDatabaseQueryCacheBridge(bridge)
  onTestFinished(() => {
    resetDatabaseQueryCacheBridge()
    queryCacheInternals.resetDatabaseDependencyInvalidationListeners()
    clearGeneratedTables()
  })

  const listen = () => {
    const events: { readonly unordered: boolean }[] = []
    queryCacheInternals.onDatabaseDependencyInvalidated((event: PublishedEvent) => {
      const metadata = event.__holoDatabaseDependencyMetadata__
      if (metadata) events.push({ unordered: metadata.unordered === true })
    })
    return events
  }

  return { heldWrite, listen }
}

function unorderedFlags(events: readonly { readonly unordered: boolean }[]) {
  return events.map(event => event.unordered)
}

describe('mutation publication ordering', () => {
  it('neither reads the publication sequence nor records publications while nothing listens', async () => {
    const { heldWrite } = await openItems()
    const touched: string[] = []
    const state = queryCacheInternals.getQueryCacheBridgeState()
    state.mutationPublications = {
      get prunedThrough() { touched.push('prunedThrough'); return 0 },
      set prunedThrough(_value) { touched.push('prunedThrough') },
      get records() { touched.push('records'); return [] },
      get sequence() { touched.push('sequence'); return 0 },
      set sequence(_value) { touched.push('sequence') },
    }
    onTestFinished(() => { state.mutationPublications = undefined })

    const finish = await heldWrite(() => DB.table('items').where('id', 1).update({ label: 'held' }))
    await DB.table('items').insert({ id: 3, label: 'three' })
    await DB.table('items').upsert({ id: 2, label: 'upserted' }, ['id'], ['label'])
    await DB.table('items').where('id', 3).delete()
    await finish()
    await queryCacheInternals.receiveRemoteDatabaseDependencyInvalidation({ id: 'remote-1', connectionName: 'default', dependencies: ['db:default:items'] })

    expect(touched).toEqual([])
  })

  it('re-runs a publication that overlaps an earlier-published write to the same row, and patches the rest', async () => {
    const { heldWrite, listen } = await openItems()
    const events = listen()

    const finishSameRow = await heldWrite(() => DB.table('items').where('id', 1).update({ label: 'earlier' }))
    await DB.table('items').where('id', 1).update({ label: 'later' })
    await finishSameRow()
    const finishOtherRow = await heldWrite(() => DB.table('items').where('id', 1).update({ label: 'again' }))
    await DB.table('items').where('id', 2).update({ label: 'other row' })
    await finishOtherRow()
    await DB.table('items').where('id', 1).update({ label: 'after' })

    expect(unorderedFlags(events)).toEqual([false, true, false, false, false])
  })

  it('treats writes it cannot identify by row as overlapping every row of the table, but not other tables', async () => {
    const { heldWrite, listen } = await openItems()
    const events = listen()

    const finishTableWide = await heldWrite(() => DB.table('items').where('id', 1).update({ label: 'earlier' }))
    await DB.table('items').truncate()
    await finishTableWide()
    const finishOtherTable = await heldWrite(() => DB.table('items').insert({ id: 5, label: 'five' }))
    await DB.table('others').truncate()
    await finishOtherTable()

    expect(unorderedFlags(events)).toEqual([false, true, false, false])
  })

  it('re-runs a publication that overlaps a remote invalidation of the same table', async () => {
    const { heldWrite, listen } = await openItems()
    const events = listen()

    const finishSameTable = await heldWrite(() => DB.table('items').where('id', 1).update({ label: 'local' }))
    await queryCacheInternals.receiveRemoteDatabaseDependencyInvalidation({ id: 'remote-items', connectionName: 'default', dependencies: ['db:default:items'] })
    await finishSameTable()
    const finishOtherTable = await heldWrite(() => DB.table('items').where('id', 1).update({ label: 'local again' }))
    await queryCacheInternals.receiveRemoteDatabaseDependencyInvalidation({ id: 'remote-others', connectionName: 'default', dependencies: ['db:default:others'] })
    await finishOtherTable()

    expect(unorderedFlags(events)).toEqual([true, false])
  })

  it('re-runs a publication that started before realtime stopped and started listening again', async () => {
    const { heldWrite, listen } = await openItems()
    const stopListening = queryCacheInternals.onDatabaseDependencyInvalidated(() => {})

    const finish = await heldWrite(() => DB.table('items').where('id', 1).update({ label: 'earlier' }))
    stopListening()
    await DB.table('items').where('id', 1).update({ label: 'later' })
    const events = listen()
    await finish()
    await DB.table('items').where('id', 2).update({ label: 'after' })

    expect(unorderedFlags(events)).toEqual([true, false])
  })

  it('keeps the listening boundary when the retained publication history is pruned afterwards', async () => {
    const { heldWrite, listen } = await openItems()
    const stopListening = queryCacheInternals.onDatabaseDependencyInvalidated(() => {})
    for (let id = 10; id < 10 + 1024; id += 1) {
      await DB.table('others').insert({ id, label: 'filler' })
    }

    const finish = await heldWrite(() => DB.table('items').where('id', 1).update({ label: 'earlier' }))
    stopListening()
    await DB.table('items').where('id', 1).update({ label: 'later' })
    const events = listen()
    await DB.table('others').insert({ id: 5000, label: 'unrelated' })
    await finish()

    expect(unorderedFlags(events)).toEqual([false, true])
  })

  it('re-runs a publication whose start is older than the retained publication history', async () => {
    const { heldWrite, listen } = await openItems()
    const events = listen()

    const finish = await heldWrite(() => DB.table('items').where('id', 1).update({ label: 'held' }))
    for (let id = 10; id < 10 + 1025; id += 1) {
      await DB.table('others').insert({ id, label: 'filler' })
    }
    await finish()

    expect(events.at(-1)?.unordered).toBe(true)
    expect(events.slice(0, -1).some(event => event.unordered)).toBe(false)
  })

  it('matches row identities by numeric value and by case, and keeps other keys apart', async () => {
    const { heldWrite, listen } = await openItems()
    await DB.table('codes').insert([{ code: '1', label: 'one' }, { code: '1.00', label: 'one point zero' }, { code: 'FR', label: 'France' }, { code: 'fr ', label: 'france' }, { code: 'DE', label: 'Germany' }])
    const events = listen()

    const finishNumeric = await heldWrite(() => DB.table('codes').where('code', '1').update({ label: 'numeric' }))
    await DB.table('codes').where('code', '1.00').update({ label: 'numeric text' })
    await finishNumeric()
    const finishCase = await heldWrite(() => DB.table('codes').where('code', 'FR').update({ label: 'upper' }))
    await DB.table('codes').where('code', 'fr ').update({ label: 'lower' })
    await finishCase()
    const finishOther = await heldWrite(() => DB.table('codes').where('code', 'FR').update({ label: 'again' }))
    await DB.table('codes').where('code', 'DE').update({ label: 'other' })
    await finishOther()

    expect(unorderedFlags(events)).toEqual([false, true, false, true, false, false])
  })

  it('treats a write of more rows than it keeps identities for as overlapping every row of the table', async () => {
    const { heldWrite, listen } = await openItems()
    const events = listen()

    const finish = await heldWrite(() => DB.table('items').where('id', 1).update({ label: 'held' }))
    await DB.table('items').insert(Array.from({ length: 1025 }, (_, index) => ({ id: 100 + index, label: 'bulk' })))
    await finish()

    expect(unorderedFlags(events)).toEqual([false, true])
  })
})
