import { describe, it } from 'vitest'
import {
  dispatch,
  dispatchSync,
  defineJob,
  normalizeQueueConfig,
  Queue,
  type ExportedQueueJobDefinition,
  type NormalizedHoloQueueConfig,
  type QueueDriver,
  type QueuePluginConnectionConfig,
  type QueueJobDefinition,
  type QueueJobEnvelope,
  type NormalizedQueuePluginConnectionConfig,
  type QueuePendingDispatch,
  type QueueJsonValue,
  type QueueSharedRedisConfig,
  useQueueConnection,
} from '../src'

declare module '../src' {
  interface HoloQueueJobRegistry {
    'reports.generate': QueueJobDefinition<{ reportId: string }, { ok: true }>
  }
}

declare module '../src/contracts' {
  interface HoloQueueJobRegistry {
    'reports.generate': QueueJobDefinition<{ reportId: string }, { ok: true }>
  }
}

describe('@holo-js/queue typing', () => {
  it('preserves typing for job definitions, envelopes, dispatch calls, and normalized config', () => {
    const job = defineJob<{ reportId: string }>({
      queue: 'reports',
      async handle(payload) {
        return payload.reportId
      },
    })

    const typedJob: QueueJobDefinition<{ reportId: string }, unknown> = job
    const expectDefinedJobPayloadTypes = () => {
      const jobDispatch: QueuePendingDispatch<{ reportId: string }> = job.dispatch({
        reportId: 'rep-1',
      })
      const jobDispatchSync: Promise<unknown> = job.dispatchSync({
        reportId: 'rep-1',
      })
      job.dispatch({
        // @ts-expect-error defined job dispatch uses the handle payload type
        wrong: 123,
      })
      job.dispatchSync({
        // @ts-expect-error defined job dispatchSync uses the handle payload type
        wrong: 123,
      })
      void jobDispatch
      void jobDispatchSync
    }
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
    const pluginConnection: QueuePluginConnectionConfig = {
      driver: 'custom-driver',
      queue: 'custom-jobs',
    }
    const normalizedPluginConnection: NormalizedQueuePluginConnectionConfig = {
      name: 'custom',
      driver: 'custom-driver',
      queue: 'custom-jobs',
      retryAfter: 90,
      blockFor: 5,
    }
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
    const expectRegisteredQueuePayloadTypes = () => {
      // @ts-expect-error registered job names must use their registry payload type
      dispatch('reports.generate', {
        wrong: 123,
      })
      // @ts-expect-error registered job names must use their registry payload type
      dispatchSync('reports.generate', {
        wrong: 123,
      })
      // @ts-expect-error connection dispatch preserves registered payload inference
      Queue.connection('sync').dispatch('reports.generate', {
        wrong: 123,
      })
      // @ts-expect-error connection dispatchSync preserves registered payload inference
      useQueueConnection('sync').dispatchSync('reports.generate', {
        wrong: 123,
      })
    }
    const dynamicPending: QueuePendingDispatch<{ anything: boolean }> = dispatch(`reports.${'dynamic'}`, {
      anything: true,
    })
    type SyncDispatchResult = Awaited<ReturnType<typeof dispatchSync<'reports.generate'>>>
    const syncResult: SyncDispatchResult = { ok: true }
    const exportedJob = defineJob<{ reportId: string }>({
      async handle(payload) {
        return {
          ok: payload.reportId.length > 0,
        }
      },
    })
    type SelectedExportType = ExportedQueueJobDefinition<typeof exportedJob>
    type SelectedPayload = SelectedExportType extends QueueJobDefinition<infer TPayload, infer _TResult> ? TPayload : never
    type SelectedResult = SelectedExportType extends QueueJobDefinition<infer _TPayload, infer TResult> ? TResult : never
    const selectedPayload: SelectedPayload = {
      reportId: 'rep-1',
    }
    const selectedResult: SelectedResult = undefined

    void typedJob
    void normalized
    void normalizedWithSharedRedis
    void pluginConnection
    void normalizedPluginConnection
    void envelope
    void driver
    void expectDefinedJobPayloadTypes
    void typedPending
    void expectRegisteredQueuePayloadTypes
    void dynamicPending
    void syncResult
    void exportedJob
    void selectedPayload
    void selectedResult
  })
})
