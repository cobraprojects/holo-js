import { ConfigurationError, DatabaseError } from './errors'
import { AsyncLocalStorage } from 'node:async_hooks'
import { transactionScopeIdentity, type TransactionScopeIdentity } from './transactionScope'
import type { ConcurrencyOptions, DriverAdapter } from './types'

export type SchedulingMode = 'concurrent' | 'serialized' | 'worker'

export interface QuerySchedulerOptions {
  connectionName: string
  supportsConcurrentQueries: boolean
  supportsWorkerThreads: boolean
  concurrency?: ConcurrencyOptions
}

type QueueState = {
  active: number
  queued: number
  readonly limit: number
  readonly waiters: Array<() => void>
}

class ExclusiveGate {
  private activeOperations = 0
  private exclusiveActive = false
  private exclusivePending = 0
  private readonly operationWaiters: Array<() => void> = []
  private readonly exclusiveWaiters: Array<() => void> = []
  private readonly exclusiveScope = new AsyncLocalStorage<{ active: boolean }>()

  isWithinExclusive(): boolean {
    return this.exclusiveScope.getStore()?.active === true
  }

  async exclusive<T>(callback: () => Promise<T>): Promise<T> {
    if (this.isWithinExclusive()) return callback()
    this.exclusivePending += 1
    if (this.exclusiveActive || this.activeOperations > 0) {
      await new Promise<void>((resolve) => this.exclusiveWaiters.push(resolve))
    }
    this.exclusivePending -= 1
    this.exclusiveActive = true
    const scope = { active: true }
    try {
      return await this.exclusiveScope.run(scope, callback)
    } finally {
      scope.active = false
      this.exclusiveActive = false
      this.wake()
    }
  }

  acquireOperation(): Promise<void> | undefined {
    if (this.exclusiveActive || this.exclusivePending > 0) {
      return new Promise<void>((resolve) => {
        this.operationWaiters.push(() => {
          this.activeOperations += 1
          resolve()
        })
      })
    }
    this.activeOperations += 1
    return undefined
  }

  releaseOperation(): void {
    this.activeOperations -= 1
    this.wake()
  }

  private wake(): void {
    if (this.exclusiveActive || this.activeOperations > 0) return
    const exclusive = this.exclusiveWaiters.shift()
    if (exclusive) {
      this.exclusiveActive = true
      exclusive()
      return
    }
    for (const resolve of this.operationWaiters.splice(0)) resolve()
  }
}

const objectGates = new WeakMap<object, ExclusiveGate>()
const namedGates = new Map<string, WeakRef<ExclusiveGate>>()
const namedGateCleanup = new FinalizationRegistry<{ name: string, gate: WeakRef<ExclusiveGate> }>(({ name, gate }) => {
  if (namedGates.get(name) === gate) namedGates.delete(name)
})

function namedGate(name: string): ExclusiveGate {
  const existing = namedGates.get(name)?.deref()
  if (existing) return existing
  const gate = new ExclusiveGate()
  const reference = new WeakRef(gate)
  namedGates.set(name, reference)
  namedGateCleanup.register(gate, { name, gate: reference })
  return gate
}

function objectGate(identity: object): ExclusiveGate {
  let gate = objectGates.get(identity)
  if (!gate) {
    gate = new ExclusiveGate()
    objectGates.set(identity, gate)
  }
  return gate
}

function sharedGate(identity: TransactionScopeIdentity): ExclusiveGate {
  return typeof identity === 'string' ? namedGate(identity) : objectGate(identity)
}

let bindGateAdapter: (scheduler: QueryScheduler, adapter: DriverAdapter) => void

let readGate: (scheduler: QueryScheduler) => ExclusiveGate

export class QueryScheduler {
  static {
    bindGateAdapter = (scheduler, adapter) => {
      scheduler.gateAdapter = adapter
    }
    readGate = scheduler => scheduler.gate
  }

  private readonly connectionName: string
  private readonly queueLimit: number
  private readonly supportsConcurrentQueries: boolean
  private readonly supportsWorkerThreads: boolean
  private readonly concurrentState: QueueState
  private readonly serializedState: QueueState
  private readonly workerState: QueueState
  private gateAdapter?: DriverAdapter
  private boundGate?: { readonly identity: TransactionScopeIdentity, readonly gate: ExclusiveGate }
  private readonly ownGate = new ExclusiveGate()
  private readonly transactionScope = new AsyncLocalStorage<QueueState>()

  constructor(options: QuerySchedulerOptions) {
    const maxConcurrentQueries = options.concurrency?.maxConcurrentQueries
    const queueLimit = options.concurrency?.queueLimit

    if (typeof maxConcurrentQueries !== 'undefined' && (!Number.isInteger(maxConcurrentQueries) || maxConcurrentQueries < 1)) {
      throw new ConfigurationError('Concurrency maxConcurrentQueries must be an integer greater than 0.')
    }

    if (typeof queueLimit !== 'undefined' && (!Number.isInteger(queueLimit) || queueLimit < 0)) {
      throw new ConfigurationError('Concurrency queueLimit must be an integer greater than or equal to 0.')
    }

    this.connectionName = options.connectionName
    this.queueLimit = queueLimit ?? Number.POSITIVE_INFINITY
    this.supportsConcurrentQueries = options.supportsConcurrentQueries
    this.supportsWorkerThreads = options.supportsWorkerThreads

    const concurrencyLimit = maxConcurrentQueries ?? (options.supportsConcurrentQueries ? Number.POSITIVE_INFINITY : 1)

    this.concurrentState = {
      active: 0,
      queued: 0,
      limit: concurrencyLimit,
      waiters: [],
    }
    this.serializedState = {
      active: 0,
      queued: 0,
      limit: 1,
      waiters: [],
    }
    this.workerState = {
      active: 0,
      queued: 0,
      limit: concurrencyLimit,
      waiters: [],
    }
  }

  private get gate(): ExclusiveGate {
    if (!this.gateAdapter) return this.ownGate
    const identity = transactionScopeIdentity(this.gateAdapter)
    if (this.boundGate?.identity !== identity) this.boundGate = { identity, gate: sharedGate(identity) }
    return this.boundGate.gate
  }

  async schedule<T>(
    options: {
      transactional: boolean
      preferWorkerThreads?: boolean
      withinExclusive?: boolean
    },
    callback: (schedulingMode: SchedulingMode) => Promise<T>,
  ): Promise<{ result: T, schedulingMode: SchedulingMode }> {
    const transactionState = this.transactionScope.getStore()
    const gate = this.gate
    const withinExclusive = options.withinExclusive || gate.isWithinExclusive() || !!transactionState
    if (!withinExclusive) {
      const operationWait = gate.acquireOperation()
      if (operationWait) await operationWait
    }
    const schedulingMode = this.preview(options)
    const state = transactionState ?? this.resolveState(schedulingMode)

    let slotReserved = false

    if (state.active >= state.limit) {
      if (state.queued >= this.queueLimit) {
        if (!withinExclusive) {
          gate.releaseOperation()
        }
        throw new DatabaseError(
          `Query scheduler queue limit exceeded for connection "${this.connectionName}".`,
          'QUERY_SCHEDULER_BACKPRESSURE',
        )
      }

      await this.waitForSlot(state)
      slotReserved = true
    }

    if (!slotReserved) {
      state.active += 1
    }

    try {
      return {
        result: await callback(schedulingMode),
        schedulingMode,
      }
    } finally {
      state.active -= 1
      this.wakeNext(state)
      if (!withinExclusive) {
        gate.releaseOperation()
      }
    }
  }

  async transaction<T>(callback: () => Promise<T>): Promise<T> {
    if (this.transactionScope.getStore()) return callback()
    const scheduled = await this.schedule({ transactional: false }, () => this.transactionScope.run({
      active: 0,
      queued: 0,
      limit: 1,
      waiters: [],
    }, callback))
    return scheduled.result
  }

  exclusive<T>(callback: () => Promise<T>): Promise<T> {
    return this.gate.exclusive(callback)
  }

  preview(options: {
    transactional: boolean
    preferWorkerThreads?: boolean
  }): SchedulingMode {
    return this.resolveMode(options)
  }

  private resolveMode(options: {
    transactional: boolean
    preferWorkerThreads?: boolean
  }): SchedulingMode {
    if (options.transactional || this.transactionScope.getStore()) {
      return 'serialized'
    }

    if (options.preferWorkerThreads && this.supportsWorkerThreads) {
      return 'worker'
    }

    if (this.supportsConcurrentQueries) {
      return 'concurrent'
    }

    return 'serialized'
  }

  private resolveState(mode: SchedulingMode): QueueState {
    if (mode === 'concurrent') {
      return this.concurrentState
    }

    if (mode === 'worker') {
      return this.workerState
    }

    return this.serializedState
  }

  private waitForSlot(state: QueueState): Promise<void> {
    state.queued += 1

    return new Promise((resolve) => {
      state.waiters.push(() => {
        state.queued -= 1
        state.active += 1
        resolve()
      })
    })
  }

  private wakeNext(state: QueueState): void {
    state.waiters.shift()?.()
  }
}

export function createQueryScheduler(options: QuerySchedulerOptions): QueryScheduler {
  return new QueryScheduler(options)
}

export function createAdapterQueryScheduler(options: QuerySchedulerOptions, adapter: DriverAdapter): QueryScheduler {
  const scheduler = new QueryScheduler(options)
  bindGateAdapter(scheduler, adapter)
  return scheduler
}

export function isWithinExclusive(scheduler: QueryScheduler): boolean {
  return readGate(scheduler).isWithinExclusive()
}
