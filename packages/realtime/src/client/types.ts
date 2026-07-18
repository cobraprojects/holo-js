import type {
  RealtimeArgsFor,
  RealtimeExecutionResult,
  RealtimeQueryDefinition,
  RealtimeResultFor,
  RealtimeSubscriptionSnapshot,
} from '../contracts'
import type { RealtimePatchPathSegment } from '../runtime/result-patching'

export type RealtimeQueryStore<TResult> = {
  readonly key: string
  readonly snapshot: RealtimeSubscriptionSnapshot<TResult> | undefined
  load(): Promise<RealtimeSubscriptionSnapshot<TResult>>
  connect(): void
  subscribe(listener: () => void): () => void
}

export type RealtimeClientTransport = {
  query<TResult>(name: string, args: Record<string, unknown>): Promise<RealtimeSubscriptionSnapshot<TResult>>
  mutate<TResult>(name: string, args: Record<string, unknown>): Promise<RealtimeExecutionResult<TResult>>
  subscribe<TResult>(
    name: string,
    args: Record<string, unknown>,
    listener: (snapshot: RealtimeSubscriptionSnapshot<TResult>) => void,
    onError: (error: unknown) => void,
  ): () => void
}

export type RealtimeFrameworkRuntime = {
  useQuery?<TDefinition extends RealtimeQueryDefinition>(
    definition: TDefinition,
    args: RealtimeArgsFor<TDefinition>,
  ): RealtimeResultFor<TDefinition>
  handleError?(error: unknown): void
}

export type MutableRealtimeQueryStore<TResult> = RealtimeQueryStore<TResult> & {
  disconnect(): void
  dispose(): void
  setSnapshot(snapshot: RealtimeSubscriptionSnapshot<TResult>): void
}

export type RealtimeClientState = {
  framework?: RealtimeFrameworkRuntime
  transport?: RealtimeClientTransport
  stores: Map<string, MutableRealtimeQueryStore<unknown>>
  warnedMessages: Set<string>
}

export type SharedRealtimeSnapshot<TResult> = {
  readonly changed: boolean
  readonly hash: string | undefined
  readonly snapshot: RealtimeSubscriptionSnapshot<TResult>
}

export type RealtimeClientErrorKind = 'authorization' | 'transport' | 'runtime'

export type RealtimeClientErrorOptions = {
  readonly name?: string
  readonly status?: number
  readonly code?: string
  readonly kind?: RealtimeClientErrorKind
}

export type BroadcastClientConfig = {
  readonly key: string
  readonly host: string
  readonly port: number
  readonly path: string
  readonly scheme: 'http' | 'https'
}

export type RealtimeWireAction = 'query' | 'mutation' | 'subscribe' | 'unsubscribe'

export type RealtimeWireResult<TResult> = {
  readonly id: string
  readonly result?: RealtimeExecutionResult<TResult>
  readonly snapshot?: RealtimeSubscriptionSnapshot<TResult>
}

export type RealtimeWireReplacePatchOperation = {
  readonly op: 'replace'
  readonly path: readonly RealtimePatchPathSegment[]
  readonly value: unknown
}

export type RealtimeWireUndefinedReplacePatchOperation = {
  readonly op: 'replace'
  readonly path: readonly RealtimePatchPathSegment[]
  readonly valueKind: 'undefined'
}

export type RealtimeWireMergePatchOperation = {
  readonly op: 'merge'
  readonly path: readonly RealtimePatchPathSegment[]
  readonly fields: Readonly<Record<string, unknown>>
}

export type RealtimeWireSplicePatchOperation = {
  readonly op: 'splice'
  readonly path: readonly RealtimePatchPathSegment[]
  readonly index: number
  readonly deleteCount: number
  readonly values: readonly unknown[]
}

export type RealtimeWireMovePatchOperation = {
  readonly op: 'move'
  readonly path: readonly RealtimePatchPathSegment[]
  readonly from: number
  readonly to: number
}

export type RealtimeWirePatchOperation =
  | RealtimeWireReplacePatchOperation
  | RealtimeWireUndefinedReplacePatchOperation
  | RealtimeWireMergePatchOperation
  | RealtimeWireSplicePatchOperation
  | RealtimeWireMovePatchOperation

export type RealtimeWireSnapshotPatch = {
  readonly dependencies?: readonly string[]
  readonly operations: readonly RealtimeWirePatchOperation[]
  readonly version: number
}

export type RealtimeWireError = {
  readonly message: string
  readonly name?: string
  readonly status?: number
  readonly code?: string
  readonly kind?: RealtimeClientErrorKind
}

export type RealtimeWebSocketLike = {
  readonly readyState: number
  send(value: string): void
  close(): void
  addEventListener(event: 'open', listener: () => void): void
  addEventListener(event: 'close', listener: () => void): void
  addEventListener(event: 'error', listener: () => void): void
  addEventListener(event: 'message', listener: (event: { readonly data: unknown }) => void): void
}

export type RealtimeWebSocketConstructor = new (url: string) => RealtimeWebSocketLike

export type RealtimeClientGlobals = typeof globalThis & {
  readonly WebSocket?: RealtimeWebSocketConstructor
  readonly fetch?: typeof fetch
  readonly location?: {
    readonly protocol?: string
    readonly hostname?: string
  }
}

export const missingTransportMessage = 'Realtime is not connected because broadcast support is not configured. Run "holo install broadcast" and start the broadcast worker with "holo broadcast:work" to enable live updates.'
export const unavailableTransportMessage = 'Realtime live updates are unavailable because the broadcast worker is not reachable. Start the worker with "holo broadcast:work" to enable live updates.'
