import { describe, expect, it } from 'vitest'
import { realtimeClientInternals } from '../src/client'
import {
  isPatchedRealtimeSnapshot,
  isStaleRealtimeSnapshot,
  shouldNotifyPatchedRealtimeSnapshot,
} from '../src/client/patching'
import type { RealtimeSubscriptionSnapshot } from '../src/contracts'
import type { RealtimeWirePatchOperation } from '../src/client/types'

describe('@holo-js/realtime client patching', () => {
  it('rejects malformed and prototype-unsafe wire snapshot patches', () => {
    expect(realtimeClientInternals.parseWireSnapshotPatch(null)).toBeUndefined()
    expect(realtimeClientInternals.parseWireSnapshotPatch([])).toBeUndefined()
    expect(realtimeClientInternals.parseWireSnapshotPatch({ operations: [], version: -1 })).toBeUndefined()
    expect(realtimeClientInternals.parseWireSnapshotPatch({ operations: {}, version: 1 })).toBeUndefined()
    expect(realtimeClientInternals.parseWireSnapshotPatch({
      operations: [{ op: 'replace', path: '__proto__', value: true }],
      version: 1,
    })).toBeUndefined()
    expect(realtimeClientInternals.parseWireSnapshotPatch({
      operations: [{ op: 'replace', path: ['__proto__'], value: true }],
      version: 1,
    })).toBeUndefined()
    expect(realtimeClientInternals.parseWireSnapshotPatch({
      operations: [{ op: 'replace', path: [1.5], value: true }],
      version: 1,
    })).toBeUndefined()
    expect(realtimeClientInternals.parseWireSnapshotPatch({
      operations: [null],
      version: 1,
    })).toBeUndefined()
    expect(realtimeClientInternals.parseWireSnapshotPatch({
      operations: [{ op: 'replace', path: [], value: true, valueKind: 'value' }],
      version: 1,
    })).toBeUndefined()
    expect(realtimeClientInternals.parseWireSnapshotPatch({
      dependencies: ['posts', 1],
      operations: [],
      version: 1,
    })).toBeUndefined()
    expect(realtimeClientInternals.parseWireSnapshotPatch({
      operations: [{ op: 'merge', path: [], fields: [] }],
      version: 1,
    })).toBeUndefined()
    expect(realtimeClientInternals.parseWireSnapshotPatch({
      operations: [{ op: 'merge', path: [], fields: { constructor: true } }],
      version: 1,
    })).toBeUndefined()
    expect(realtimeClientInternals.parseWireSnapshotPatch({
      operations: [{ op: 'merge', path: [], fields: Object.create({ total: 1 }) }],
      version: 1,
    })).toBeUndefined()
    expect(realtimeClientInternals.parseWireSnapshotPatch({
      operations: [{ op: 'move', path: [], from: 0, to: -1 }],
      version: 1,
    })).toBeUndefined()
    expect(realtimeClientInternals.parseWireSnapshotPatch({
      operations: [{ op: 'splice', path: [], index: 0, deleteCount: 0, values: {} }],
      version: 1,
    })).toBeUndefined()
  })

  it('applies mixed wire operations with stale patch guards and structural sharing', () => {
    type PostRow = Readonly<{ id: number, title: string }>

    const firstRow: PostRow = Object.freeze({ id: 1, title: 'First' })
    const secondRow: PostRow = Object.freeze({ id: 2, title: 'Second' })
    const snapshot: RealtimeSubscriptionSnapshot<{
      readonly rows: readonly PostRow[]
      readonly meta: { readonly total: number }
    }> = {
      name: 'posts.list',
      data: Object.freeze({
        rows: Object.freeze([firstRow, secondRow]),
        meta: Object.freeze({ total: 2 }),
      }),
      dependencies: ['table:posts'],
      version: 2,
    }

    const stale = realtimeClientInternals.applyWireSnapshotPatch(snapshot, {
      operations: [{
        op: 'replace',
        path: ['meta', 'total'],
        value: 3,
      }],
      version: 2,
    })

    expect(stale).toBe(snapshot)

    const parsed = realtimeClientInternals.parseWireSnapshotPatch({
      dependencies: ['table:posts', 'query:posts.list'],
      operations: [
        {
          op: 'merge',
          path: ['meta'],
          fields: { total: 3 },
        },
        {
          op: 'splice',
          path: ['rows'],
          index: 1,
          deleteCount: 0,
          values: [{ id: 3, title: 'Third' }],
        },
        {
          op: 'splice',
          path: ['rows'],
          index: 0,
          deleteCount: 1,
          values: [],
        },
        {
          op: 'move',
          path: ['rows'],
          from: 1,
          to: 0,
        },
      ],
      version: 3,
    })

    if (!parsed) {
      throw new Error('Expected wire snapshot patch to parse.')
    }

    const patched = realtimeClientInternals.applyWireSnapshotPatch(snapshot, parsed)

    expect(isPatchedRealtimeSnapshot(patched)).toBe(true)
    expect(patched.dependencies).toEqual(['table:posts', 'query:posts.list'])
    expect(patched.version).toBe(3)
    expect(patched.data).toEqual({
      rows: [
        { id: 2, title: 'Second' },
        { id: 3, title: 'Third' },
      ],
      meta: { total: 3 },
    })
    expect(patched.data.rows[0]).toBe(secondRow)
  })

  it('applies all-replace patches through the shared replacement path', () => {
    const snapshot: RealtimeSubscriptionSnapshot<{
      readonly rows: readonly { readonly title?: string }[]
      readonly meta: { readonly total: number }
    }> = {
      name: 'posts.replace',
      data: Object.freeze({
        rows: Object.freeze([Object.freeze({ title: 'First' })]),
        meta: Object.freeze({ total: 1 }),
      }),
      dependencies: [],
      version: 1,
    }

    const parsed = realtimeClientInternals.parseWireSnapshotPatch({
      operations: [
        {
          op: 'replace',
          path: ['meta', 'total'],
          value: 2,
        },
        {
          op: 'replace',
          path: ['rows', 0, 'title'],
          valueKind: 'undefined',
        },
      ],
      version: 2,
    })

    if (!parsed) {
      throw new Error('Expected wire snapshot patch to parse.')
    }

    const patched = realtimeClientInternals.applyWireSnapshotPatch(snapshot, parsed)

    expect(patched.data).toEqual({
      rows: [{}],
      meta: { total: 2 },
    })
  })

  it('applies root replace operations in mixed patch streams', () => {
    const snapshot: RealtimeSubscriptionSnapshot<{
      readonly rows: readonly { readonly title: string }[]
      readonly meta?: { readonly total: number }
    }> = {
      name: 'posts.root-replace',
      data: Object.freeze({
        rows: Object.freeze([Object.freeze({ title: 'First' })]),
        meta: Object.freeze({ total: 1 }),
      }),
      dependencies: [],
      version: 1,
    }

    const patched = realtimeClientInternals.applyWireSnapshotPatch(snapshot, {
      operations: [
        {
          op: 'replace',
          path: [],
          value: { rows: [{ title: 'Replacement' }] },
        },
        {
          op: 'merge',
          path: [],
          fields: { meta: { total: 1 } },
        },
      ],
      version: 2,
    })

    expect(patched.data).toEqual({
      rows: [{ title: 'Replacement' }],
      meta: { total: 1 },
    })
  })

  it('keeps equivalent object replace patches structurally shared across wire payloads', () => {
    const row = Object.freeze({
      id: 1,
      meta: Object.freeze({ views: 1 }),
      title: 'First',
    })
    const snapshot: RealtimeSubscriptionSnapshot<{
      readonly rows: readonly (typeof row)[]
      readonly summary: { readonly total: number }
    }> = {
      name: 'posts.equivalent-replace',
      data: Object.freeze({
        rows: Object.freeze([row]),
        summary: Object.freeze({ total: 1 }),
      }),
      dependencies: [],
      version: 1,
    }

    const patched = realtimeClientInternals.applyWireSnapshotPatch(snapshot, {
      operations: [
        {
          op: 'replace',
          path: ['rows', 0],
          value: {
            id: 1,
            meta: { views: 1 },
            title: 'First',
          },
        },
        {
          op: 'replace',
          path: ['summary'],
          value: {
            total: 1,
          },
        },
      ],
      version: 2,
    })

    expect(patched.data).toBe(snapshot.data)
    expect(patched.data.rows[0]).toBe(row)
    expect(patched.version).toBe(2)
  })

  it('keeps equivalent root object replace patches structurally shared', () => {
    const snapshot: RealtimeSubscriptionSnapshot<{
      readonly rows: readonly { readonly id: number, readonly title: string }[]
      readonly summary: { readonly total: number }
    }> = {
      name: 'posts.equivalent-root-replace',
      data: Object.freeze({
        rows: Object.freeze([Object.freeze({ id: 1, title: 'First' })]),
        summary: Object.freeze({ total: 1 }),
      }),
      dependencies: [],
      version: 1,
    }

    const patched = realtimeClientInternals.applyWireSnapshotPatch(snapshot, {
      operations: [
        {
          op: 'replace',
          path: [],
          value: {
            rows: [{ id: 1, title: 'First' }],
            summary: { total: 1 },
          },
        },
      ],
      version: 2,
    })

    expect(patched.data).toBe(snapshot.data)
    expect(patched.version).toBe(2)
  })

  it('keeps equivalent object merge fields structurally shared across wire payloads', () => {
    const profile = Object.freeze({
      avatar: Object.freeze({ color: 'blue' }),
      name: 'Ada',
    })
    const row = Object.freeze({
      id: 1,
      profile,
      title: 'First',
    })
    const snapshot: RealtimeSubscriptionSnapshot<{
      readonly rows: readonly (typeof row)[]
    }> = {
      name: 'posts.equivalent-merge',
      data: Object.freeze({
        rows: Object.freeze([row]),
      }),
      dependencies: [],
      version: 1,
    }

    const patched = realtimeClientInternals.applyWireSnapshotPatch(snapshot, {
      operations: [
        {
          op: 'merge',
          path: ['rows', 0],
          fields: {
            profile: {
              avatar: { color: 'blue' },
              name: 'Ada',
            },
          },
        },
      ],
      version: 2,
    })

    expect(patched.data).toBe(snapshot.data)
    expect(patched.data.rows[0]).toBe(row)
    expect(patched.data.rows[0]?.profile).toBe(profile)
    expect(patched.version).toBe(2)
  })

  it('keeps equivalent splice replacement values structurally shared across wire payloads', () => {
    const firstRow = Object.freeze({
      id: 1,
      title: 'First',
    })
    const secondRow = Object.freeze({
      id: 2,
      meta: Object.freeze({ views: 2 }),
      title: 'Second',
    })
    const thirdRow = Object.freeze({
      id: 3,
      meta: Object.freeze({ views: 3 }),
      title: 'Third',
    })
    const summary = Object.freeze({ total: 3 })
    const snapshot: RealtimeSubscriptionSnapshot<{
      readonly rows: readonly (typeof firstRow | typeof secondRow | typeof thirdRow)[]
      readonly summary: typeof summary
    }> = {
      name: 'posts.equivalent-splice',
      data: Object.freeze({
        rows: Object.freeze([firstRow, secondRow, thirdRow]),
        summary,
      }),
      dependencies: [],
      version: 1,
    }

    const unchanged = realtimeClientInternals.applyWireSnapshotPatch(snapshot, {
      operations: [
        {
          op: 'splice',
          path: ['rows'],
          index: 1,
          deleteCount: 1,
          values: [
            {
              id: 2,
              meta: { views: 2 },
              title: 'Second',
            },
          ],
        },
      ],
      version: 2,
    })

    expect(unchanged.data).toBe(snapshot.data)
    expect(unchanged.data.rows[1]).toBe(secondRow)

    const changed = realtimeClientInternals.applyWireSnapshotPatch(snapshot, {
      operations: [
        {
          op: 'splice',
          path: ['rows'],
          index: 1,
          deleteCount: 2,
          values: [
            {
              id: 2,
              meta: { views: 2 },
              title: 'Second',
            },
            {
              id: 3,
              meta: { views: 4 },
              title: 'Third',
            },
          ],
        },
      ],
      version: 3,
    })

    expect(changed.data).not.toBe(snapshot.data)
    expect(changed.data.summary).toBe(summary)
    expect(changed.data.rows[0]).toBe(firstRow)
    expect(changed.data.rows[1]).toBe(secondRow)
    expect(changed.data.rows[2]).not.toBe(thirdRow)
    expect(changed.data.rows[2]).toEqual({
      id: 3,
      meta: { views: 4 },
      title: 'Third',
    })

    const withIgnoredSplice = realtimeClientInternals.applyWireSnapshotPatch(snapshot, {
      operations: [
        {
          op: 'splice',
          path: ['rows'],
          index: 1,
          deleteCount: 1,
          values: [
            {
              id: 2,
              meta: { views: 2 },
              title: 'Second',
            },
          ],
        },
        {
          op: 'splice',
          path: ['rows'],
          index: 99,
          deleteCount: 0,
          values: [{ id: 99, title: 'Ignored' }],
        },
      ],
      version: 4,
    })

    expect(withIgnoredSplice.data).toBe(snapshot.data)

    const replacedAndInserted = realtimeClientInternals.applyWireSnapshotPatch(snapshot, {
      operations: [
        {
          op: 'splice',
          path: ['rows'],
          index: 1,
          deleteCount: 1,
          values: [
            {
              id: 2,
              meta: { views: 2 },
              title: 'Second',
            },
            {
              id: 4,
              title: 'Fourth',
            },
          ],
        },
      ],
      version: 5,
    })

    expect(replacedAndInserted.data.rows[1]).toBe(secondRow)
    expect(replacedAndInserted.data.rows[2]).toEqual({
      id: 4,
      title: 'Fourth',
    })
  })

  it('preserves equivalent merge field references while applying changed fields', () => {
    const profile = Object.freeze({
      avatar: Object.freeze({ color: 'blue' }),
      name: 'Ada',
    })
    const row = Object.freeze({
      id: 1,
      profile,
      title: 'First',
    })
    const snapshot: RealtimeSubscriptionSnapshot<{
      readonly rows: readonly (typeof row)[]
    }> = {
      name: 'posts.partial-merge-sharing',
      data: Object.freeze({
        rows: Object.freeze([row]),
      }),
      dependencies: [],
      version: 1,
    }

    const patched = realtimeClientInternals.applyWireSnapshotPatch(snapshot, {
      operations: [
        {
          op: 'merge',
          path: ['rows', 0],
          fields: {
            profile: {
              avatar: { color: 'blue' },
              name: 'Ada',
            },
            title: 'Updated',
          },
        },
      ],
      version: 2,
    })

    expect(patched.data).not.toBe(snapshot.data)
    expect(patched.data.rows[0]).toEqual({
      id: 1,
      profile,
      title: 'Updated',
    })
    expect(patched.data.rows[0]?.profile).toBe(profile)
  })

  it('compares realtime snapshot versions and patched data identity', () => {
    const snapshot: RealtimeSubscriptionSnapshot<readonly number[]> = {
      name: 'numbers.versioned',
      data: Object.freeze([1]),
      dependencies: [],
      version: 2,
    }

    expect(isStaleRealtimeSnapshot(snapshot, {
      ...snapshot,
      version: 2,
    })).toBe(true)
    expect(shouldNotifyPatchedRealtimeSnapshot(snapshot, snapshot)).toBe(false)
    expect(shouldNotifyPatchedRealtimeSnapshot(snapshot, {
      ...snapshot,
      version: 3,
    })).toBe(true)
    expect(shouldNotifyPatchedRealtimeSnapshot(snapshot, {
      ...snapshot,
      dependencies: ['table:numbers'],
      version: 3,
    })).toBe(true)
    expect(shouldNotifyPatchedRealtimeSnapshot(snapshot, {
      ...snapshot,
      data: Object.freeze([1, 2]),
      version: 3,
    })).toBe(true)
  })

  it('ignores no-op and invalid merge and move operations without cloning data', () => {
    const snapshot: RealtimeSubscriptionSnapshot<{
      readonly rows: readonly number[]
      readonly meta: { readonly total: number }
    }> = {
      name: 'numbers.list',
      data: Object.freeze({
        rows: Object.freeze([1, 2, 3]),
        meta: Object.freeze({ total: 3 }),
      }),
      dependencies: [],
      version: 1,
    }

    const patched = realtimeClientInternals.applyWireSnapshotPatch(snapshot, {
      operations: [
        {
          op: 'merge',
          path: ['meta'],
          fields: { total: 3 },
        },
        {
          op: 'merge',
          path: ['rows'],
          fields: { total: 3 },
        },
        {
          op: 'move',
          path: ['rows'],
          from: 0,
          to: 0,
        },
        {
          op: 'move',
          path: ['rows'],
          from: 3,
          to: 0,
        },
        {
          op: 'move',
          path: ['missing'],
          from: 0,
          to: 1,
        },
      ],
      version: 2,
    })

    expect(patched.data).toBe(snapshot.data)
    expect(patched.version).toBe(2)
  })

  it('applies mixed replace operations and keeps invalid moves unchanged', () => {
    const snapshot: RealtimeSubscriptionSnapshot<{
      readonly rows: readonly (number | undefined)[]
      readonly meta: { readonly total: number, readonly label: string }
    }> = {
      name: 'numbers.mixed',
      data: Object.freeze({
        rows: Object.freeze([1, undefined, 3]),
        meta: Object.freeze({ total: 3, label: 'before' }),
      }),
      dependencies: [],
      version: 1,
    }

    const patched = realtimeClientInternals.applyWireSnapshotPatch(snapshot, {
      operations: [
        {
          op: 'replace',
          path: ['meta', 'label'],
          value: 'after',
        },
        {
          op: 'merge',
          path: ['meta'],
          fields: { total: 4 },
        },
        {
          op: 'move',
          path: ['rows'],
          from: 1,
          to: 0,
        },
      ],
      version: 2,
    })

    expect(patched.data).toEqual({
      rows: [1, undefined, 3],
      meta: { total: 4, label: 'after' },
    })
  })

  it('applies adjacent splices independently when their paths differ', () => {
    const snapshot: RealtimeSubscriptionSnapshot<{
      readonly first: readonly number[]
      readonly second: readonly number[]
    }> = {
      name: 'numbers.splices',
      data: Object.freeze({
        first: Object.freeze([1, 3]),
        second: Object.freeze([4, 6]),
      }),
      dependencies: [],
      version: 1,
    }

    const patched = realtimeClientInternals.applyWireSnapshotPatch(snapshot, {
      operations: [
        {
          op: 'splice',
          path: ['first'],
          index: 1,
          deleteCount: 0,
          values: [2],
        },
        {
          op: 'splice',
          path: ['second'],
          index: 1,
          deleteCount: 0,
          values: [5],
        },
      ],
      version: 2,
    })

    expect(patched.data).toEqual({
      first: [1, 2, 3],
      second: [4, 5, 6],
    })
  })

  it('skips sparse operations and groups only matching adjacent splice paths', () => {
    const snapshot: RealtimeSubscriptionSnapshot<{
      readonly first: readonly number[]
      readonly second: readonly number[]
    }> = {
      name: 'numbers.sparse-splices',
      data: Object.freeze({
        first: Object.freeze([1, 4]),
        second: Object.freeze([5, 7]),
      }),
      dependencies: [],
      version: 1,
    }
    const operations: RealtimeWirePatchOperation[] = [
      {
        op: 'splice',
        path: ['first'],
        index: 1,
        deleteCount: 0,
        values: [2],
      },
    ]
    operations.length = 4
    operations[2] = {
      op: 'splice',
      path: ['first', 2],
      index: 0,
      deleteCount: 0,
      values: [3],
    }
    operations[3] = {
      op: 'splice',
      path: ['second'],
      index: 1,
      deleteCount: 0,
      values: [6],
    }

    const patched = realtimeClientInternals.applyWireSnapshotPatch(snapshot, {
      operations,
      version: 2,
    })

    expect(patched.data).toEqual({
      first: [1, 2, 4],
      second: [5, 6, 7],
    })
  })

  it('applies root merge and root move patches with structural sharing', () => {
    const objectSnapshot: RealtimeSubscriptionSnapshot<{
      readonly count: number
      readonly label: string
    }> = {
      name: 'root.merge',
      data: Object.freeze({
        count: 1,
        label: 'before',
      }),
      dependencies: [],
      version: 1,
    }

    const unchangedObject = realtimeClientInternals.applyWireSnapshotPatch(objectSnapshot, {
      operations: [
        {
          op: 'merge',
          path: [],
          fields: { count: 1 },
        },
      ],
      version: 2,
    })
    expect(unchangedObject.data).toBe(objectSnapshot.data)

    const changedObject = realtimeClientInternals.applyWireSnapshotPatch(objectSnapshot, {
      operations: [
        {
          op: 'merge',
          path: [],
          fields: { count: 2 },
        },
      ],
      version: 3,
    })
    expect(changedObject.data).toEqual({
      count: 2,
      label: 'before',
    })

    const arraySnapshot: RealtimeSubscriptionSnapshot<readonly number[]> = {
      name: 'root.move',
      data: Object.freeze([1, 2, 3]),
      dependencies: [],
      version: 1,
    }
    const moved = realtimeClientInternals.applyWireSnapshotPatch(arraySnapshot, {
      operations: [
        {
          op: 'move',
          path: [],
          from: 2,
          to: 0,
        },
      ],
      version: 2,
    })
    expect(moved.data).toEqual([3, 1, 2])

    const sparseRows = [1, undefined, 3] as readonly (number | undefined)[]
    const sparseSnapshot: RealtimeSubscriptionSnapshot<readonly (number | undefined)[]> = {
      name: 'root.sparse-move',
      data: Object.freeze(sparseRows),
      dependencies: [],
      version: 1,
    }
    const sparseMoved = realtimeClientInternals.applyWireSnapshotPatch(sparseSnapshot, {
      operations: [
        {
          op: 'move',
          path: [],
          from: 1,
          to: 0,
        },
      ],
      version: 2,
    })
    expect(sparseMoved.data).toBe(sparseSnapshot.data)
  })
})
