import { describe, expect, it } from 'vitest'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { executeRealtimeMutation, subscribeRealtimeQuery } from '../src/server'
import { openRealtimeDatabase } from './helpers/native-database'

describe('native grouped aggregate subscriptions', () => {
  it.each(['count', 'sum', 'avg', 'min', 'max'] as const)('keeps grouped %s results correct through inserts, updates, moves, nulls, and deletes', async kind => {
    const { adapter, db } = await openRealtimeDatabase()
    let reads = 0
    const snapshots: Array<readonly Readonly<Record<string, unknown>>[]> = []
    const query = defineRealtimeQuery({ access: 'public', handler: () => {
      reads += 1
      const builder = db.table('records').where('active', 1).groupBy('group_id').orderBy('group_id').select('group_id')
      return (kind === 'count' ? builder.addSelectCount('value')
        : kind === 'sum' ? builder.addSelectSum('value', 'score')
          : kind === 'avg' ? builder.addSelectAvg('value', 'score')
            : kind === 'min' ? builder.addSelectMin('value', 'score')
              : builder.addSelectMax('value', 'score')).get()
    } })
    await subscribeRealtimeQuery(query, {}, { onData: snapshot => { snapshots.push(snapshot.data) }, onError: error => { throw error } })
    const verify = async () => {
      const result = await adapter.query(`SELECT group_id, ${kind.toUpperCase()}(${kind === 'count' ? '*' : 'score'}) AS value FROM records WHERE active = 1 GROUP BY group_id ORDER BY group_id`)
      expect(snapshots.at(-1)).toEqual(result.rows)
    }
    await verify()
    const changes = [
      () => db.table('records').insert({ id: 6, group_id: 1, score: 15, active: 1 }),
      () => db.table('records').where('id', 1).update({ score: 35 }),
      () => db.table('records').where('id', 2).update({ group_id: 2 }),
      () => db.table('records').where('id', 3).update({ active: 0 }),
      () => db.table('records').where('id', 4).delete(),
      () => db.table('records').insert({ id: 7, group_id: 4, score: null, active: 1 }),
      () => db.table('records').where('group_id', 1).delete(),
    ]
    for (const [index, change] of changes.entries()) {
      await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: change }))
      await verify()
      expect(reads, `After mutation ${index}`).toBe(1)
    }
    const published = snapshots.length
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table('records').where('id', 5).update({ score: 100 }) }))
    expect(snapshots).toHaveLength(published)
    expect(reads).toBe(1)
  })

  it.each(['count', 'sum', 'avg', 'min', 'max'] as const)('retains hidden %s groups as they enter and leave HAVING', async kind => {
    const { adapter, db } = await openRealtimeDatabase()
    const expression = `${kind.toUpperCase()}(${kind === 'count' ? '*' : 'score'})`
    const threshold = 2
    let reads = 0
    const snapshots: Array<readonly Readonly<Record<string, unknown>>[]> = []
    const query = defineRealtimeQuery({ access: 'public', handler: () => {
      reads += 1
      const builder = db.table('records').where('active', 1).groupBy('group_id').orderBy('group_id').select('group_id').having('count(*)', '>=', threshold)
      return (kind === 'count' ? builder.addSelectCount('value')
        : kind === 'sum' ? builder.addSelectSum('value', 'score')
          : kind === 'avg' ? builder.addSelectAvg('value', 'score')
            : kind === 'min' ? builder.addSelectMin('value', 'score')
              : builder.addSelectMax('value', 'score')).get()
    } })
    await subscribeRealtimeQuery(query, {}, { onData: snapshot => { snapshots.push(snapshot.data) }, onError: error => { throw error } })
    const verify = async () => {
      const result = await adapter.query(`SELECT group_id, ${expression} AS value FROM records WHERE active = 1 GROUP BY group_id HAVING COUNT(*) >= ? ORDER BY group_id`, [threshold])
      expect(snapshots.at(-1)).toEqual(result.rows)
    }
    await verify()
    for (const change of [
      () => db.table('records').where('id', 5).update({ active: 1, score: 50 }),
      () => db.table('records').insert({ id: 6, group_id: 3, score: 50, active: 1 }),
      () => db.table('records').where('group_id', 3).update({ score: 5 }),
      () => db.table('records').where('id', 6).delete(),
      () => db.table('records').where('id', 5).update({ score: 100 }),
      () => db.table('records').where('group_id', 3).delete(),
    ]) {
      await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: change }))
      await verify()
    }
    expect(reads).toBe(1)
  })
})
