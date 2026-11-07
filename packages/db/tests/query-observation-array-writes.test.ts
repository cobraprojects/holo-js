import { describe, expect, it } from 'vitest'
import { queryCacheInternals, recordDatabaseQueryObservation, serializeDatabaseQueryObservationsOnArrayWrites, type DatabaseQueryObservation } from '../src/cache'

const observation: DatabaseQueryObservation = Object.freeze({
  connectionName: 'default',
  dependencies: Object.freeze(['db:default:comments']),
  orderBy: Object.freeze([]),
  patchable: true,
  predicates: Object.freeze([]),
  selections: Object.freeze([]),
  tableName: 'comments',
})

async function collect(callback: () => void): Promise<boolean> {
  const result = await queryCacheInternals.collectDatabaseQueryDependencies(() => {
    recordDatabaseQueryObservation(observation)
    callback()
  }) as { queries: readonly DatabaseQueryObservation[] }
  return result.queries[0]!.serialized === true
}

class Comments extends Array<number> {
  override push(...items: number[]): number {
    return super.push(...items.map(item => item * 10))
  }
}

describe('array writes inside a dependency collection', () => {
  it.each(['copyWithin', 'fill', 'pop', 'push', 'reverse', 'shift', 'sort', 'splice', 'unshift'] as const)('re-runs instead of patching after %s()', async (method) => {
    expect(await collect(() => {
      const rows = [2, 1]
      serializeDatabaseQueryObservationsOnArrayWrites(rows)
      ;(rows[method] as (...args: unknown[]) => unknown).apply(rows, method === 'sort' ? [] : [0])
    })).toBe(true)
  })

  it('keeps patching when the array is only read', async () => {
    expect(await collect(() => {
      const rows = [1, 2]
      serializeDatabaseQueryObservationsOnArrayWrites(rows)
      expect(rows.filter(row => row > 1)).toEqual([2])
    })).toBe(false)
  })

  it('keeps the array methods working as before, under their own names', async () => {
    await collect(() => {
      const rows = [3, 1, 2]
      serializeDatabaseQueryObservationsOnArrayWrites(rows)
      expect(rows.push(4)).toBe(4)
      expect(rows.splice(0, 1)).toEqual([3])
      expect(rows.sort()).toBe(rows)
      expect(rows).toEqual([1, 2, 4])
      expect([rows.push.name, rows.push.length, rows.splice.name, rows.splice.length]).toEqual(['push', 1, 'splice', 2])
      expect(Object.keys(rows)).toEqual(['0', '1', '2'])
    })
  })

  it('ignores writes made outside the collection that tracked the array', async () => {
    const rows = [1, 2]
    expect(await collect(() => serializeDatabaseQueryObservationsOnArrayWrites(rows))).toBe(false)
    expect(await collect(() => rows.push(3))).toBe(false)
    expect(await collect(() => {
      serializeDatabaseQueryObservationsOnArrayWrites(rows)
      rows.push(4)
    })).toBe(true)
    expect(rows).toEqual([1, 2, 3, 4])
  })

  it('leaves frozen, sealed, non-extensible and subclassed arrays untouched', async () => {
    const arrays = [Object.freeze([1]), Object.seal([1]), Object.preventExtensions([1]), Comments.from([1])]
    await collect(() => {
      for (const rows of arrays) serializeDatabaseQueryObservationsOnArrayWrites(rows)
    })
    expect(arrays.map(rows => Object.hasOwn(rows, 'push'))).toEqual([false, false, false, false])
    const comments = arrays[3] as Comments
    comments.push(2)
    expect([...comments]).toEqual([1, 20])
  })

  it('keeps the own write methods of an array and still sees what they change', async () => {
    const rows = [1]
    const push = (...items: number[]) => Array.prototype.push.apply(rows, items)
    Object.defineProperty(rows, 'push', { configurable: true, enumerable: false, value: push, writable: true })
    expect(await collect(() => {
      serializeDatabaseQueryObservationsOnArrayWrites(rows)
      rows.push(2)
    })).toBe(true)
    expect(rows.push).toBe(push)
  })

  it.each([
    ['Array.prototype.splice.call()', (rows: number[]) => Array.prototype.splice.call(rows, 0, 1)],
    ['an index write', (rows: number[]) => { rows[0] = 3 }],
    ['a shorter length', (rows: number[]) => { rows.length = 1 }],
    ['delete', (rows: number[]) => { delete rows[1] }],
  ] as const)('re-runs instead of patching after %s changes the tracked array', async (_label, write) => {
    for (const rows of [[1, 2], Comments.from([1, 2])]) {
      expect(await collect(() => {
        serializeDatabaseQueryObservationsOnArrayWrites(rows)
        write(rows)
      })).toBe(true)
    }
  })

  it('re-runs instead of patching after an index write changes a sealed array', async () => {
    const rows = Object.seal([1, 2])
    expect(await collect(() => {
      serializeDatabaseQueryObservationsOnArrayWrites(rows)
      rows[0] = 3
    })).toBe(true)
  })

  it('keeps patching when a write outside the wrapped methods leaves the array as it was', async () => {
    expect(await collect(() => {
      const rows = [1, 2]
      serializeDatabaseQueryObservationsOnArrayWrites(rows)
      Array.prototype.splice.call(rows, 0, 0)
      rows[0] = 1
    })).toBe(false)
  })

  it('registers an array without running its own iterator', async () => {
    class OneShotComments extends Array<number> {
      override [Symbol.iterator](): ArrayIterator<number> {
        throw new Error('iterated')
      }
    }
    const rows = OneShotComments.from([1, 2])
    expect(await collect(() => serializeDatabaseQueryObservationsOnArrayWrites(rows))).toBe(false)
  })

  it('re-runs instead of patching after a hole in the tracked array is filled', async () => {
    const rows: Array<number | undefined> = [1, 2, 3]
    delete rows[1]
    expect(await collect(() => {
      serializeDatabaseQueryObservationsOnArrayWrites(rows)
      rows[1] = undefined
    })).toBe(true)
  })

  it('re-runs instead of patching an array with an indexed getter without calling the getter', async () => {
    let reads = 0
    const rows: number[] = [1, 2]
    Object.defineProperty(rows, 1, { configurable: true, enumerable: true, get: () => { reads += 1; throw new Error('read') } })
    expect(await collect(() => serializeDatabaseQueryObservationsOnArrayWrites(rows))).toBe(true)
    expect(reads).toBe(0)
  })

  it('re-runs instead of patching after an indexed getter replaces an element of the tracked array', async () => {
    let reads = 0
    const rows = [1, 2]
    expect(await collect(() => {
      serializeDatabaseQueryObservationsOnArrayWrites(rows)
      Object.defineProperty(rows, 0, { configurable: true, enumerable: true, get: () => { reads += 1; return 1 } })
    })).toBe(true)
    expect(reads).toBe(0)
  })
})
