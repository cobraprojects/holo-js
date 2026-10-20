import { expect, it, onTestFinished } from 'vitest'
import { defineRealtimeQuery, type RealtimeSubscriptionSnapshot } from '../src'
import {
  configureRealtimeClientTransport,
  getRealtimeQueryStore,
  resetRealtimeClientRuntime,
  type RealtimeClientTransport,
} from '../src/client'

type Delivery = { readonly resync?: boolean }
type Listener = (snapshot: RealtimeSubscriptionSnapshot<string[]>, delivery?: Delivery) => void

function snapshot(data: string[], version: number): RealtimeSubscriptionSnapshot<string[]> {
  return { name: 'posts.list', data, dependencies: [], version }
}

function createScriptedTransport() {
  let listener: Listener | undefined
  const transport: RealtimeClientTransport = {
    async query<TResult>() {
      return snapshot(['loaded'], 1) as unknown as RealtimeSubscriptionSnapshot<TResult>
    },
    async mutate() {
      throw new Error('Mutations are not scripted.')
    },
    subscribe<TResult>(_name: string, _args: Record<string, unknown>, next: (snapshot: RealtimeSubscriptionSnapshot<TResult>, delivery?: Delivery) => void) {
      listener = next as unknown as Listener
      return () => {}
    },
  }
  return {
    transport,
    emit(next: RealtimeSubscriptionSnapshot<string[]>, delivery?: Delivery) {
      listener!(next, delivery)
    },
  }
}

const listPosts = defineRealtimeQuery({
  name: 'posts.list',
  access: 'public',
  handler: async () => ['loaded'],
})

async function connectedStore() {
  const scripted = createScriptedTransport()
  configureRealtimeClientTransport(scripted.transport)
  onTestFinished(resetRealtimeClientRuntime)
  const store = getRealtimeQueryStore<string[]>(listPosts, {})
  await store.load()
  store.connect()
  return { store, scripted }
}

it('keeps the newest version when a custom transport delivers an older snapshot later', async () => {
  const { store, scripted } = await connectedStore()

  scripted.emit(snapshot(['newer'], 5))
  scripted.emit(snapshot(['older'], 4))

  expect(store.snapshot).toMatchObject({ version: 5, data: ['newer'] })
})

it('accepts a lower version as a new generation when the transport marks it as a resync', async () => {
  const { store, scripted } = await connectedStore()

  scripted.emit(snapshot(['before'], 5))
  scripted.emit(snapshot(['after'], 1), { resync: true })
  expect(store.snapshot).toMatchObject({ version: 1, data: ['after'] })

  scripted.emit(snapshot(['stale'], 0))
  expect(store.snapshot).toMatchObject({ version: 1, data: ['after'] })
})
