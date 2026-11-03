import assert from 'node:assert/strict'

export async function assertExampleAppQueryBehavior(DB, schema, connection, { column, defineGeneratedTable, defineModel, hasMany }) {
  await schema.createTable('native_query_records', table => {
    table.id()
    table.string('name')
    table.integer('score')
    table.string('category')
    table.json('settings')
    table.timestamp('created_at')
  })
  await schema.createTable('native_query_labels', table => {
    table.id()
    table.integer('record_id')
    table.string('label')
  })
  const recordsTable = defineGeneratedTable('native_query_records', {
    id: column.id(),
    name: column.string(),
    score: column.integer(),
    category: column.string(),
    settings: column.json(),
    created_at: column.timestamp(),
  })
  const labelsTable = defineGeneratedTable('native_query_labels', {
    id: column.id(),
    record_id: column.integer(),
    label: column.string(),
  })
  const records = () => DB.table(recordsTable, connection)
  const labels = () => DB.table(labelsTable, connection)
  try {
    await records().insert([
      { name: 'Alpha', score: 10, category: 'a', settings: { region: 'eu', tags: ['one', 'two'] }, created_at: '2026-04-01T10:00:00.000Z' },
      { name: 'Beta', score: 20, category: 'a', settings: { region: 'us', tags: ['one'] }, created_at: '2026-04-02T10:00:00.000Z' },
      { name: 'Gamma', score: 30, category: 'b', settings: { region: 'eu', tags: [] }, created_at: '2026-04-03T10:00:00.000Z' },
      { name: 'Delta', score: 40, category: 'b', settings: { region: null, tags: [] }, created_at: '2026-04-04T10:00:00.000Z' },
    ])
    await labels().insert([{ record_id: 1, label: 'featured' }, { record_id: 3, label: 'reviewed' }])
    assert.deepEqual(await records().where(query => query.where('category', 'a').orWhere('score', '>', 30)).orderBy('id').pluck('name'), ['Alpha', 'Beta', 'Delta'])
    assert.deepEqual(await records().whereIn('id', [1, 2, 3]).whereNotBetween('score', [15, 25]).orderBy('id').pluck('id'), [1, 3])
    assert.deepEqual(await records().whereColumn('score', '>', 'id').orderBy('id').pluck('id'), [1, 2, 3, 4])
    assert.deepEqual(await records().distinct().select('category').orderBy('category').get(), [{ category: 'a' }, { category: 'b' }])
    const Record = defineModel(recordsTable, { name: `NativeQueryRecord_${connection}`, connectionName: connection })
    assert.deepEqual(await Record.distinct().orderBy('category').pluck('category'), ['a', 'b'])
    const Label = defineModel(labelsTable, { name: `NativeQueryLabel_${connection}`, connectionName: connection })
    Record.resolveRelationUsing('labels', () => hasMany(() => Label, 'record_id'))
    assert.deepEqual(await Record.has('labels').orderBy('id').pluck('id'), [1, 3])
    assert.deepEqual(await Record.where('id', 2).orHas('labels').orderBy('id').pluck('id'), [1, 2, 3])
    assert.equal(await records().sum('score'), 100)
    assert.equal(await records().avg('score'), 25)
    assert.equal(await records().min('score'), 10)
    assert.equal(await records().max('score'), 40)
    assert.deepEqual(await records().select('category').addSelectSum('total', 'score').groupBy('category').having('sum(score)', '>', 40).get(), [{ category: 'b', total: 70 }])
    assert.deepEqual(await records().whereDate('created_at', '2026-04-02').pluck('id'), [2])
    assert.deepEqual(await records().whereYear('created_at', 2026).orderBy('id').pluck('id'), [1, 2, 3, 4])
    assert.deepEqual(await records().whereMonth('created_at', 4).orderBy('id').pluck('id'), [1, 2, 3, 4])
    assert.deepEqual(await records().whereDay('created_at', 2).pluck('id'), [2])
    assert.deepEqual(await records().whereJson('settings->region', 'eu').orderBy('id').pluck('id'), [1, 3])
    assert.deepEqual(await records().whereJsonContains('settings->tags', 'two').pluck('id'), [1])
    assert.deepEqual(await records().whereJsonLength('settings->tags', 0).orderBy('id').pluck('id'), [3, 4])
    assert.deepEqual(await records().whereJson('settings->region', null).pluck('id'), [4])
    await records().where('id', 1).updateJson('settings->region', 'mena')
    assert.deepEqual(await records().whereJson('settings->region', 'mena').pluck('id'), [1])
    assert.deepEqual(await records().whereJsonContains('settings->tags', 'two').pluck('id'), [1])
    assert.deepEqual(await records().join('native_query_labels', 'native_query_records.id', '=', 'native_query_labels.record_id').select('native_query_records.name', 'native_query_labels.label').orderBy('native_query_records.id').get(), [{ name: 'Alpha', label: 'featured' }, { name: 'Gamma', label: 'reviewed' }])
    assert.deepEqual(await records().leftJoin('native_query_labels', 'native_query_records.id', '=', 'native_query_labels.record_id').whereNull('native_query_labels.id').orderBy('native_query_records.id').pluck('native_query_records.id'), [2, 4])
    assert.deepEqual(await records().whereInSub('id', labels().select('record_id')).orderBy('id').pluck('id'), [1, 3])
    assert.deepEqual(await records().whereExists(labels().select('id').whereColumn('native_query_labels.record_id', '=', 'native_query_records.id')).orderBy('id').pluck('id'), [1, 3])
    assert.deepEqual(await records().select('id').where('id', '<', 3).union(records().select('id').where('id', '>', 1)).orderBy('id').get(), [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }])
    const page = await records().orderBy('id').paginate(2, 2)
    assert.deepEqual(page.data.map(row => row.id), [3, 4])
    assert.equal(page.meta.total, 4)
    assert.equal(page.meta.hasMorePages, false)
    const firstCursor = await records().orderBy('id').cursorPaginate(2)
    assert.deepEqual(firstCursor.data.map(row => row.id), [1, 2])
    assert.ok(firstCursor.nextCursor)
    const nextCursor = await records().orderBy('id').cursorPaginate(2, firstCursor.nextCursor)
    assert.deepEqual(nextCursor.data.map(row => row.id), [3, 4])
    assert.equal(nextCursor.nextCursor, null)
    const visited = []
    await records().chunkById(2, rows => { visited.push(...rows.map(row => row.id)) })
    assert.deepEqual(visited, [1, 2, 3, 4])
    const descending = []
    await records().chunkByIdDesc(2, rows => { descending.push(...rows.map(row => row.id)) })
    assert.deepEqual(descending, [4, 3, 2, 1])
    const hostile = 'Value"; DROP TABLE native_query_records; --'
    const id = await records().insertGetId({ name: hostile, score: 5, category: 'c', settings: {}, created_at: '2026-04-05T10:00:00.000Z' })
    assert.equal(await records().where('name', hostile).value('id'), id)
    await assert.rejects(records().orderBy('name; DROP TABLE native_query_records').get(), /identifier|column|allowed/i)
    assert.equal(await records().count(), 5)
    await records().where('id', 1).update({ settings: ['native', 'one'] })
    await records().where('id', 2).update({ settings: ['native', 'two'] })
    assert.deepEqual(await records().where('settings', ['native', 'one']).pluck('id'), [1])
    assert.deepEqual(await records().whereIn('settings', [['native', 'one'], ['native', 'two']]).orderBy('id').pluck('id'), [1, 2])
    assert.deepEqual(await Record.where('settings', ['native', 'one']).pluck('id'), [1])
  } finally {
    await schema.dropTable('native_query_labels')
    await schema.dropTable('native_query_records')
  }
}
