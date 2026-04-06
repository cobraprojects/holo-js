import { ConfigurationError, DatabaseError } from './errors'
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
}

export class QueryScheduler {
  private readonly connectionName: string
  private readonly queueLimit: number
  private readonly supportsConcurrentQueries: boolean
  private readonly supportsWorkerThreads: boolean
  private readonly concurrentState: QueueState
  private readonly serializedState: QueueState
  private readonly workerState: QueueState

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
    }
    this.serializedState = {
      active: 0,
      queued: 0,
      limit: 1,
    }
    this.workerState = {
      active: 0,
      queued: 0,
      limit: concurrencyLimit,
    }
  }

  async schedule<T>(
    options: {
      transactional: boolean
      preferWorkerThreads?: boolean
    },
    callback: (schedulingMode: SchedulingMode) => Promise<T>,
  ): Promise<{ result: T, schedulingMode: SchedulingMode }> {
    const schedulingMode = this.preview(options)
    const state = this.resolveState(schedulingMode)

    if (state.active >= state.limit) {
      if (state.queued >= this.queueLimit) {
        throw new DatabaseError(
          `Query scheduler queue limit exceeded for connection "${this.connectionName}".`,
          'QUERY_SCHEDULER_BACKPRESSURE',
        )
      }

      await new Promise<void>((resolve) => {
        state.queued += 1

        const poll = () => {
          if (state.active < state.limit) {
            state.queued -= 1
            resolve()
            return
          }

          queueMicrotask(poll)
        }

        queueMicrotask(poll)
      })
    }

    state.active += 1

    try {
      return {
        result: await callback(schedulingMode),
        schedulingMode,
      }
    } finally {
      state.active -= 1
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
}

export function createQueryScheduler(options: QuerySchedulerOptions): QueryScheduler {
  return new QueryScheduler(options)
}
