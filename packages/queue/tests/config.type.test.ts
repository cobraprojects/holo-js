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
} from '../src'

declare module '../src' {
  interface HoloQueueJobRegistry {
    'reports.generate': QueueJobDefinition<{ reportId: string }, { ok: true }>
  }
}

describe('@holo-js/queue typing', () => {
  it('preserves typing for job definitions, envelopes, dispatch calls, and normalized config', () => {
    type Expect<TValue extends true> = TValue
    type Equal<TLeft, TRight>
      = (<TValue>() => TValue extends TLeft ? 1 : 2) extends (<TValue>() => TValue extends TRight ? 1 : 2)
        ? ((<TValue>() => TValue extends TRight ? 1 : 2) extends (<TValue>() => TValue extends TLeft ? 1 : 2) ? true : false)
        : false

    const job = defineJob({
      queue: 'reports',
      async handle(payload: { reportId: string }) {
        return payload.reportId
      },
    })

    const typedJob: QueueJobDefinition<{ reportId: string }, string> = job
    const normalized: NormalizedHoloQueueConfig = normalizeQueueConfig()
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
    type JobModuleWithExtraExport = {
      readonly default: QueueJobDefinition<{ reportId: string }, { ok: true }>
      readonly helper: QueueJobDefinition<{ helperId: number }, { ok: false }>
    }
    type SelectedExportType = ExportedQueueJobDefinition<JobModuleWithExtraExport>
    type SelectedPayload = SelectedExportType extends QueueJobDefinition<infer TPayload, unknown> ? TPayload : never
    type SelectedResult = SelectedExportType extends QueueJobDefinition<QueueJsonValue, infer TResult> ? TResult : never
    type SelectedExportAssertion = Expect<Equal<
      SelectedPayload,
      { reportId: string }
    >>
    type SelectedResultAssertion = Expect<Equal<
      SelectedResult,
      { ok: true }
    >>

    void typedJob
    void normalized
    void envelope
    void driver
    void typedPending
    void dynamicPending
    void syncResult
    void (0 as unknown as SelectedExportAssertion)
    void (0 as unknown as SelectedResultAssertion)
  })
})
