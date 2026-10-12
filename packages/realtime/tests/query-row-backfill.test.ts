import { describe, expect, it } from 'vitest'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { executeRealtimeMutation, subscribeRealtimeQuery } from '../src/server'
import { openRealtimeDatabase } from './helpers/native-database'

describe('native subscription row backfills', () => {
  it.each([0, 1])('keeps projected windows at offset %s current across two groups', async (offset) => {
    const { adapter, db, queries } = await openRealtimeDatabase()
    await db.table('records').insert([
      { id: 6, group_id: 1, score: 60, active: 1 },
      { id: 7, group_id: 2, score: 70, active: 1 },
      { id: 8, group_id: 1, score: 80, active: 1 },
      { id: 9, group_id: 2, score: 90, active: 1 },
    ])
    const groups = [1, 2].map(group => ({ group, snapshots: [] as Array<Record<string, unknown>[]>, reads: 0 }))
    for (const state of groups) {
      const query = defineRealtimeQuery({ access: 'public', handler: () => {
        state.reads += 1
        return db.table('records').where('group_id', state.group).select('id', 'score').orderBy('id').offset(offset).limit(2).get()
      } })
      await subscribeRealtimeQuery(query, {}, {
        onData: snapshot => { state.snapshots.push(snapshot.data) }, onError: error => { throw error },
      })
    }
    const verify = async () => {
      for (const state of groups) {
        const expected = await adapter.query('SELECT id, score FROM records WHERE group_id = ? ORDER BY id LIMIT 2 OFFSET ?', [state.group, offset])
        expect(state.snapshots.at(-1)).toEqual(expected.rows)
      }
    }
    await verify()
    for (const change of [
      () => db.table('records').whereIn('id', [1, 3]).delete(),
      () => db.table('records').whereIn('id', [2, 4]).update({ group_id: 3 }),
      () => db.table('records').where('id', 6).update({ group_id: 2 }),
      () => db.table('records').where('id', 7).update({ score: 75 }),
      () => db.table('records').whereIn('group_id', [1, 2]).delete(),
    ]) {
      await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: change }))
      await verify()
    }
    expect(groups.map(state => state.reads)).toEqual([1, 1])
    if (offset > 0) expect(queries.some(query => query.sql.includes('ROW_NUMBER() OVER'))).toBe(true)
  })

  it('keeps exact projected rows current after bulk updates and deletion', async () => {
    const { adapter, db } = await openRealtimeDatabase()
    const states = [1, 2].map(id => ({ id, snapshots: [] as Array<Record<string, unknown> | undefined>, reads: 0 }))
    for (const state of states) {
      await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: () => {
        state.reads += 1
        return db.table('records').where('id', state.id).select('id', 'score').first()
      } }), {}, { onData: snapshot => { state.snapshots.push(snapshot.data) }, onError: error => { throw error } })
    }
    for (const change of [
      () => db.table('records').whereIn('id', [1, 2]).update({ score: 99 }),
      () => db.table('records').whereIn('id', [1, 2]).delete(),
    ]) {
      await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: change }))
      for (const state of states) {
        const expected = await adapter.query('SELECT id, score FROM records WHERE id = ?', [state.id])
        expect(state.snapshots.at(-1)).toEqual(expected.rows[0])
      }
    }
    expect(states.map(state => state.reads)).toEqual([1, 1])
  })
})
