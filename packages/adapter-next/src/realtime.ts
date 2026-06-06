'use client'

import { useEffect, useSyncExternalStore } from 'react'
import {
  configureRealtimeClientRuntime,
  getRealtimeQueryStore,
} from '@holo-js/realtime/client'
import type { RealtimeArgsFor, RealtimeQueryDefinition, RealtimeResultFor } from '@holo-js/realtime'

function useReactiveRealtimeQuery<TDefinition extends RealtimeQueryDefinition>(
  definition: TDefinition,
  args: RealtimeArgsFor<TDefinition>,
): RealtimeResultFor<TDefinition> {
  const store = getRealtimeQueryStore(definition, args)
  useEffect(() => {
    store.connect()
  }, [store])
  const snapshot = useSyncExternalStore(
    store.subscribe,
    () => store.snapshot,
    () => store.snapshot,
  )

  return snapshot?.data as RealtimeResultFor<TDefinition>
}

configureRealtimeClientRuntime({
  useQuery: useReactiveRealtimeQuery,
})

export {}
