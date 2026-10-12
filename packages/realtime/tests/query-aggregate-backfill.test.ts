import { describe, expect, it } from 'vitest'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { executeRealtimeMutation, subscribeRealtimeQuery } from '../src/server'
import { openRealtimeDatabase } from './helpers/native-database'

describe('native aggregate subscriptions', () => {
  it.each(['count', 'sum', 'avg', 'min', 'max'] as const)('keeps %s current through matching, excluded, duplicate, and null rows', async kind => {
    const { adapter, db } = await openRealtimeDatabase()
    let reads = 0
    const snapshots: Array<number | null> = []
    const query = defineRealtimeQuery({ access: 'public', handler: () => {
      reads += 1
      const builder = db.table('records').where('active', 1)
      return kind === 'count' ? builder.count()
        : kind === 'sum' ? builder.sum('score')
          : kind === 'avg' ? builder.avg('score')
            : kind === 'min' ? builder.min('score')
              : builder.max('score')
    } })
    await subscribeRealtimeQuery(query, {}, { onData: snapshot => { snapshots.push(snapshot.data) }, onError: error => { throw error } })
    const verify = async () => {
      const result = await adapter.query<{ value: number | null }>(`SELECT ${kind.toUpperCase()}(${kind === 'count' ? '*' : 'score'}) AS value FROM records WHERE active = 1`)
      expect(snapshots.at(-1)).toBe(kind === 'sum' ? result.rows[0]?.value ?? 0 : result.rows[0]?.value)
    }
    await verify()
    for (const change of [
      () => db.table('records').insert({ id: 6, group_id: 1, score: 30, active: 1 }),
      () => db.table('records').where('id', 3).delete(),
      () => db.table('records').where('id', 6).delete(),
      () => db.table('records').where('id', 1).update({ score: 25 }),
      () => db.table('records').where('id', 5).update({ active: 1, score: 100 }),
      () => db.table('records').where('id', 5).update({ active: 0 }),
      () => db.table('records').where('id', 2).update({ score: null }),
      () => db.table('records').where('active', 1).delete(),
    ]) {
      await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: change }))
      await verify()
    }
    expect(reads).toBe(1)
  })

  it('updates several scoped aggregates without rerunning handlers or publishing unchanged values', async () => {
    const { db } = await openRealtimeDatabase()
    let reads = 0
    const snapshots: Array<{ count: number, sum: number, average: number | null }> = []
    const query = defineRealtimeQuery({ access: 'public', handler: async () => {
      reads += 1
      const records = db.table('records').where('active', 1)
      const [count, sum, average] = await Promise.all([records.count(), records.sum('score'), records.avg('score')])
      return { count, sum, average }
    } })
    await subscribeRealtimeQuery(query, {}, { onData: snapshot => { snapshots.push(snapshot.data) }, onError: error => { throw error } })
    expect(snapshots).toEqual([{ count: 4, sum: 60, average: 20 }])
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table('records').where('id', 1).update({ score: 40 }) }))
    expect(snapshots.at(-1)).toEqual({ count: 4, sum: 90, average: 30 })
    const published = snapshots.length
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table('records').where('id', 1).update({ score: 40 }) }))
    expect(snapshots).toHaveLength(published)
    expect(reads).toBe(1)
  })

  it('publishes committed aggregate changes and preserves the previous snapshot after rollback', async () => {
    const { db } = await openRealtimeDatabase()
    const snapshots: number[] = []
    const query = defineRealtimeQuery({ access: 'public', handler: () => db.table('records').where('active', 1).sum('score') })
    await subscribeRealtimeQuery(query, {}, { onData: snapshot => { snapshots.push(snapshot.data) }, onError: error => { throw error } })
    await expect(executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.transaction(async tx => {
      await tx.table('records').where('id', 1).update({ score: 100 })
      throw new Error('abort')
    }) }))).rejects.toThrow('abort')
    expect(snapshots).toEqual([60])
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.transaction(tx => tx.table('records').where('id', 1).update({ score: 100 })) }))
    expect(snapshots).toEqual([60, 150])
  })
})
