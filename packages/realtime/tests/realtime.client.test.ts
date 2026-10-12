import { afterEach, describe, expect, it } from 'vitest'
import { getRealtimeQueryStore, hydrateRealtimeQuery, query, resetRealtimeClientRuntime, useRealtimeQuery } from '../src'

afterEach(resetRealtimeClientRuntime)

describe('public realtime hydration', () => {
  it('returns the hydrated snapshot when a query is called before a framework runtime is configured', () => {
    const listPosts = query({
      name: 'posts.list',
      access: 'public',
      handler: async () => [{ id: 1, title: 'First' }],
    })

    hydrateRealtimeQuery(listPosts, {}, {
      name: 'posts.list',
      data: [{ id: 1, title: 'First' }],
      dependencies: [],
      version: 1,
    })

    expect(useRealtimeQuery(listPosts, {})).toEqual([{ id: 1, title: 'First' }])
  })

  it('hydrates stores with normalized empty args', () => {
    const listPosts = query({
      name: 'posts.list',
      access: 'public',
      handler: async () => [{ id: 1, title: 'First' }],
    })

    hydrateRealtimeQuery(listPosts, [] as never, {
      name: 'posts.list',
      data: [{ id: 1, title: 'First' }],
      dependencies: [],
      version: 1,
    })

    expect(getRealtimeQueryStore(listPosts, undefined as never).snapshot?.data).toEqual([{ id: 1, title: 'First' }])
  })
})
