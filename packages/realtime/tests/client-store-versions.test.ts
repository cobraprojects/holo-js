import { expect, it, onTestFinished } from 'vitest'
import { defineRealtimeQuery, type RealtimeSubscriptionSnapshot } from '../src'
import {
  configureRealtimeClientTransport,
  getRealtimeQueryStore,
  hydrateRealtimeQuery,
  resetRealtimeClientRuntime,
  type RealtimeClientTransport,
} from '../src/client'
import type { RealtimeSnapshotDelivery } from '../src/client/types'

type Listener = (snapshot: RealtimeSubscriptionSnapshot<string[]>, delivery?: RealtimeSnapshotDelivery) => void

function snapshot(data: string[], version: number): RealtimeSubscriptionSnapshot<string[]> {
  return { name: 'posts.list', data, dependencies: [], version }
}

function createScriptedTransport() {
  let listener: Listener | undefined
  const transport: RealtimeClientTransport = {
    query() {
      return new Promise<never>(() => {})
    },
    async mutate() {
      throw new Error('Mutations are not scripted.')
    },
    subscribe(_name, _args, next) {
      listener = next as unknown as Listener
      return () => {
        listener = undefined
      }
    },
  }
  return {
    transport,
    emit(next: RealtimeSubscriptionSnapshot<string[]>, delivery?: RealtimeSnapshotDelivery) {
      listener?.(next, delivery)
    },
  }
}

const listPosts = defineRealtimeQuery({
  name: 'posts.list',
  access: 'public',
  handler: async () => ['loaded'],
})

function connectedStore() {
  const scripted = createScriptedTransport()
  configureRealtimeClientTransport(scripted.transport)
  onTestFinished(resetRealtimeClientRuntime)
  hydrateRealtimeQuery(listPosts, {}, snapshot(['loaded'], 1))
  const store = getRealtimeQueryStore(listPosts, {})
  store.connect()
  return { store, scripted }
}

it('keeps the newest version when a custom transport delivers an older snapshot later', () => {
  const { store, scripted } = connectedStore()

  scripted.emit(snapshot(['newer'], 5))
  scripted.emit(snapshot(['older'], 4))

  expect(store.snapshot).toMatchObject({ version: 5, data: ['newer'] })
})

it('accepts a lower version as a new generation when the transport marks it as a resync', () => {
  const { store, scripted } = connectedStore()

  scripted.emit(snapshot(['before'], 5))
  scripted.emit(snapshot(['after'], 1), { resync: true })
  expect(store.snapshot).toMatchObject({ version: 1, data: ['after'] })

  scripted.emit(snapshot(['stale'], 0))
  expect(store.snapshot).toMatchObject({ version: 1, data: ['after'] })
})
