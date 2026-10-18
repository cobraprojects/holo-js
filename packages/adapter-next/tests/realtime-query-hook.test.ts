import { Component, Suspense, createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

class QueryErrorBoundary extends Component<{ children?: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  override render() {
    return this.state.error ? createElement('output', null, `error: ${this.state.error.message}`) : this.props.children
  }
}

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('document', { getElementById: () => null })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('renders a snapshot that arrives while the first load is pending even when that load later fails', async () => {
  const { query } = await import('../src/realtime')
  const { configureRealtimeClientTransport, hydrateRealtimeQuery } = await import('@holo-js/realtime/client')
  let rejectLoad!: (error: Error) => void
  configureRealtimeClientTransport({
    query: () => new Promise((_resolve, reject) => { rejectLoad = reject }),
    async mutate<TResult>(name: string) {
      return { name, data: undefined as TResult, dependencies: [] }
    },
    subscribe() {
      return () => {}
    },
  })
  const listPosts = query({
    name: 'posts.list',
    access: 'public',
    handler: async () => [{ title: 'Live' }],
  })

  function Posts() {
    return createElement('output', null, listPosts({}).map(post => post.title).join(','))
  }

  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(createElement(QueryErrorBoundary, null, createElement(Suspense, { fallback: 'loading' }, createElement(Posts))))
  })
  expect(renderer.toJSON()).toBe('loading')

  await act(async () => {
    hydrateRealtimeQuery(listPosts, {}, { name: 'posts.list', data: [{ title: 'Live' }], dependencies: [], version: 1 })
    rejectLoad(new Error('transport unavailable'))
  })

  expect(renderer.toJSON()).toMatchObject({ type: 'output', children: ['Live'] })
  await act(async () => renderer.unmount())
})
