import { describe, it } from 'vitest'
import {
  dispatch,
  type dispatchSync,
  defineJob,
  normalizeQueueConfig,
  type ExportedQueueJobDefinition,
  type NormalizedHoloQueueConfig,
  type QueueDriver,
  type QueueJobDefinition,
  type QueueJobEnvelope,
  type QueuePendingDispatch,
  type QueueJsonValue,
  type QueueSharedRedisConfig,
} from '../src'

declare module '../src' {
  interface HoloQueueJobRegistry {
    'reports.generate': QueueJobDefinition<{ reportId: string }, { ok: true }>
  }
}

describe('@holo-js/queue typing', () => {
  it('preserves typing for job definitions, envelopes, dispatch calls, and normalized config', () => {
    const job = defineJob({
      queue: 'reports',
      async handle(payload: { reportId: string }) {
        return payload.reportId
      },
    })

    const typedJob: QueueJobDefinition<{ reportId: string }, string> = job
    const normalized: NormalizedHoloQueueConfig = normalizeQueueConfig()
    const sharedRedisConfig: QueueSharedRedisConfig = {
      default: 'cache',
      connections: {
        cache: {
          name: 'cache',
          host: '127.0.0.1',
          port: 6379,
          password: undefined,
          username: undefined,
          db: 0,
        },
      },
    }
    const normalizedWithSharedRedis: NormalizedHoloQueueConfig = normalizeQueueConfig({
      connections: {
        redis: {
          driver: 'redis',
          connection: 'cache',
        },
      },
    }, sharedRedisConfig)
    const envelope: QueueJobEnvelope<{ reportId: string }> = {
      id: 'job-1',
      name: 'reports.generate',
      connection: 'sync',
      queue: 'default',
      payload: {
        reportId: 'rep-1',
      },
      attempts: 0,
      maxAttempts: 1,
      createdAt: Date.now(),
    }

    const driver: QueueDriver = {
      name: 'sync',
      driver: 'sync',
      mode: 'sync',
      async dispatch(entry) {
        return { jobId: entry.id, synchronous: true }
      },
      async clear() {
        return 0
      },
      async close() {},
    }
    const pending = dispatch('reports.generate', {
      reportId: 'rep-1',
    })
    const typedPending: QueuePendingDispatch<{ reportId: string }> = pending
    const dynamicPending: QueuePendingDispatch<{ anything: boolean }> = dispatch(`reports.${'dynamic'}`, {
      anything: true,
    })
    type SyncDispatchResult = Awaited<ReturnType<typeof dispatchSync<'reports.generate'>>>
    const syncResult: SyncDispatchResult = { ok: true }
    const exportedJob = defineJob({
      async handle(payload: { reportId: string }) {
        return {
          ok: payload.reportId.length > 0,
        }
      },
    })
    type SelectedExportType = ExportedQueueJobDefinition<typeof exportedJob>
    type SelectedPayload = SelectedExportType extends QueueJobDefinition<infer TPayload, unknown> ? TPayload : never
    type SelectedResult = SelectedExportType extends QueueJobDefinition<QueueJsonValue, infer TResult> ? TResult : never
    const selectedPayload: SelectedPayload = {
      reportId: 'rep-1',
    }
    const selectedResult: SelectedResult = {
      ok: true,
    }

    void typedJob
    void normalized
    void normalizedWithSharedRedis
    void envelope
    void driver
    void typedPending
    void dynamicPending
    void syncResult
    void exportedJob
    void selectedPayload
    void selectedResult
  })
})
