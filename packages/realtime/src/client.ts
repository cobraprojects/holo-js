import {
  handleRealtimeConnectionError,
  handleRealtimeError,
  isRealtimeTransportAvailabilityError,
} from './client/errors'
import {
  applyWireSnapshotPatch,
  parseWireSnapshotPatch,
} from './client/patching'
import {
  configureRealtimeClientRuntime,
  configureRealtimeClientTransport,
  getRealtimeQueryStore,
  hasConfiguredRealtimeClientRuntime,
  hasConfiguredRealtimeClientTransport,
  hydrateRealtimeQuery,
  resetRealtimeClientRuntime,
  useRealtimeMutation,
  useRealtimeQuery,
} from './client/runtime'
import { getRealtimeClientState } from './client/state'
import {
  createMissingRealtimeTransport,
  createRealtimeQueryStore,
  createSharedRealtimeSnapshot,
} from './client/store'
import { createBroadcastRealtimeTransport } from './client/transport'
import {
  missingTransportMessage,
  unavailableTransportMessage,
  type RealtimeClientTransport,
  type RealtimeFrameworkRuntime,
  type RealtimeQueryStore,
} from './client/types'
import { stableStringify } from './client/utils'

export {
  configureRealtimeClientRuntime,
  configureRealtimeClientTransport,
  createBroadcastRealtimeTransport,
  getRealtimeQueryStore,
  hasConfiguredRealtimeClientRuntime,
  hasConfiguredRealtimeClientTransport,
  hydrateRealtimeQuery,
  resetRealtimeClientRuntime,
  useRealtimeMutation,
  useRealtimeQuery,
}

export type {
  RealtimeClientTransport,
  RealtimeFrameworkRuntime,
  RealtimeQueryStore,
}

export const realtimeClientInternals = {
  createBroadcastRealtimeTransport,
  createMissingRealtimeTransport,
  createRealtimeQueryStore,
  createSharedRealtimeSnapshot,
  applyWireSnapshotPatch,
  getRealtimeClientState,
  handleRealtimeError,
  handleRealtimeConnectionError,
  isRealtimeTransportAvailabilityError,
  missingTransportMessage,
  parseWireSnapshotPatch,
  stableStringify,
  unavailableTransportMessage,
}
