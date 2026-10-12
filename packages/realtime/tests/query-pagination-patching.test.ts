import type { SerializeModels } from '@holo-js/db'
import { describe, expect, it } from 'vitest'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { executeRealtimeMutation, subscribeRealtimeQuery } from '../src/server'
import { openRealtimeDatabase } from './helpers/native-database'

describe('native paginated subscriptions', () => {
  it.each([
    ['standard', 1], ['standard', 2], ['simple', 1], ['simple', 2],
  ] as const)('keeps %s page %s and its metadata current as rows enter and leave', async (kind, page) => {
    const { adapter, db } = await openRealtimeDatabase()
    let reads = 0
    const handler = () => {
      reads += 1
      const builder = db.table('records').where('active', 1).orderBy('id')
      return kind === 'standard' ? builder.paginate(2, page, { pageName: 'recordsPage' }) : builder.simplePaginate(2, page, { pageName: 'recordsPage' })
    }
    const snapshots: SerializeModels<Awaited<ReturnType<typeof handler>>>[] = []
    await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, {
      onData: snapshot => { snapshots.push(snapshot.data) }, onError: error => { throw error },
    })
    const verify = async () => {
      const count = await adapter.query<{ total: number }>('SELECT COUNT(*) AS total FROM records WHERE active = 1')
      const total = count.rows[0]?.total
      if (total === undefined) throw new Error('Expected a native count')
      const rows = await adapter.query('SELECT * FROM records WHERE active = 1 ORDER BY id LIMIT 2 OFFSET ?', [(page - 1) * 2])
      const latest = snapshots.at(-1)
      if (!latest) throw new Error('Expected a subscription snapshot')
      expect(latest.data).toEqual(rows.rows)
      expect(latest.meta.currentPage).toBe(page)
      expect(latest.meta.pageName).toBe('recordsPage')
      expect(latest.meta.hasMorePages).toBe(total > page * 2)
      if (kind === 'standard') {
        expect(latest.meta).toMatchObject({ total, lastPage: Math.max(1, Math.ceil(total / 2)) })
      }
    }
    await verify()
    for (const change of [
      () => db.table('records').insert({ id: 6, group_id: 3, score: 50, active: 1 }),
      () => db.table('records').where('id', 5).update({ active: 1 }),
      () => db.table('records').where('id', 1).delete(),
      () => db.table('records').where('id', 2).update({ active: 0 }),
      () => db.table('records').where('id', 3).update({ score: 40 }),
      () => db.table('records').where('active', 1).delete(),
    ]) {
      await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: change }))
      await verify()
    }
    expect(reads).toBe(1)
  })

  it('refreshes joined pages against native rows when mutations require a full query', async () => {
    const { adapter, db } = await openRealtimeDatabase()
    await adapter.execute('CREATE TABLE groups (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
    await adapter.execute("INSERT INTO groups VALUES (1, 'First'), (2, 'Second'), (3, 'Third')")
    let reads = 0
    const handler = () => {
      reads += 1
      return db.table('records').join('groups', 'records.group_id', '=', 'groups.id').select('records.id', 'groups.name').orderBy('records.id').paginate(2)
    }
    const snapshots: SerializeModels<Awaited<ReturnType<typeof handler>>>[] = []
    await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, {
      onData: snapshot => { snapshots.push(snapshot.data) }, onError: error => { throw error },
    })
    expect(snapshots.at(-1)?.data).toEqual([{ id: 1, name: 'First' }, { id: 2, name: 'First' }])
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table('groups').where('id', 1).update({ name: 'Updated' }) }))
    expect(snapshots.at(-1)?.data).toEqual([{ id: 1, name: 'Updated' }, { id: 2, name: 'Updated' }])
    expect(snapshots.at(-1)?.meta.total).toBe(5)
    expect(reads).toBe(2)
  })
})
