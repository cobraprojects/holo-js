import { ConfigurationError, DatabaseError } from './errors'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { ConcurrencyOptions } from './types'

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

export class QueryScheduler {
  private readonly connectionName: string
  private readonly queueLimit: number
  private readonly supportsConcurrentQueries: boolean
  private readonly supportsWorkerThreads: boolean
  private readonly concurrentState: QueueState
  private readonly serializedState: QueueState
  private readonly workerState: QueueState
  private activeOperations = 0
  private exclusiveActive = false
  private exclusivePending = 0
  private readonly operationWaiters: Array<() => void> = []
  private readonly exclusiveWaiters: Array<() => void> = []
  private readonly exclusiveScope = new AsyncLocalStorage<boolean>()

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

  async schedule<T>(
    options: {
      transactional: boolean
      preferWorkerThreads?: boolean
      withinExclusive?: boolean
    },
    callback: (schedulingMode: SchedulingMode) => Promise<T>,
  ): Promise<{ result: T, schedulingMode: SchedulingMode }> {
    const withinExclusive = options.withinExclusive || this.exclusiveScope.getStore() === true
    if (!withinExclusive) {
      const operationWait = this.acquireOperation()
      if (operationWait) await operationWait
    }
    const schedulingMode = this.preview(options)
    const state = this.resolveState(schedulingMode)

    let slotReserved = false

    if (state.active >= state.limit) {
      if (state.queued >= this.queueLimit) {
        if (!withinExclusive) {
          this.releaseOperation()
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
        this.releaseOperation()
      }
    }
  }

  async exclusive<T>(callback: () => Promise<T>): Promise<T> {
    this.exclusivePending += 1
    if (this.exclusiveActive || this.activeOperations > 0) {
      await new Promise<void>((resolve) => this.exclusiveWaiters.push(resolve))
    }
    this.exclusivePending -= 1
    this.exclusiveActive = true
    try {
      return await this.exclusiveScope.run(true, callback)
    } finally {
      this.exclusiveActive = false
      this.wakeGate()
    }
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
    if (options.transactional) {
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

  private acquireOperation(): Promise<void> | undefined {
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

  private releaseOperation(): void {
    this.activeOperations -= 1
    this.wakeGate()
  }

  private wakeGate(): void {
    if (this.exclusiveActive || this.activeOperations > 0) return
    const exclusive = this.exclusiveWaiters.shift()
    if (exclusive) {
      exclusive()
      return
    }
    for (const resolve of this.operationWaiters.splice(0)) resolve()
  }
}

export function createQueryScheduler(options: QuerySchedulerOptions): QueryScheduler {
  return new QueryScheduler(options)
}
