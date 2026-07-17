import { describe, expect, it } from 'vitest'
import { defineJob, isQueueJobDefinition, normalizeQueueJobDefinition, queueJobInternals } from '../src'

describe('@holo-js/queue jobs', () => {
  it('normalizes and freezes valid job definitions', () => {
    const job = defineJob({
      connection: ' redis ',
      queue: ' media ',
      tries: 3,
      backoff: [5, 30, 120],
      timeout: 60,
      async handle() {
        return 'ok'
      },
    })

    expect(job).toMatchObject({
      connection: 'redis',
      queue: 'media',
      tries: 3,
      backoff: [5, 30, 120],
      timeout: 60,
    })
    expect(typeof job.dispatch).toBe('function')
    expect(typeof job.dispatchSync).toBe('function')
    expect(Object.keys(job)).toEqual(['connection', 'queue', 'tries', 'backoff', 'timeout', 'handle'])
    expect(Object.isFrozen(job)).toBe(true)
    expect(Object.isFrozen(job.backoff)).toBe(true)
  })

  it('accepts omitted optional metadata and scalar backoff values', () => {
    const job = defineJob({
      backoff: 10,
      onCompleted() {},
      onFailed() {},
      async handle() {},
    })

    expect(job.backoff).toBe(10)
    expect(typeof job.onCompleted).toBe('function')
    expect(typeof job.onFailed).toBe('function')
  })

  it('identifies queue job definitions by handle shape', () => {
    expect(isQueueJobDefinition({
      async handle() {},
    })).toBe(true)
    expect(isQueueJobDefinition(undefined)).toBe(false)
    expect(isQueueJobDefinition({})).toBe(false)
  })

  it('rejects job definition dispatch before registration', () => {
    const job = defineJob({
      async handle(payload: { readonly userId: string }) {
        return payload.userId
      },
    })

    expect(() => job.dispatch({
      userId: 'usr-1',
    })).toThrow('Job definitions cannot dispatch before the job is registered.')

    expect(() => job.dispatchSync({
      userId: 'usr-1',
    })).toThrow('Job definitions cannot dispatch before the job is registered.')
  })

  it('rejects job definition dispatch before runtime dispatchers are loaded', () => {
    const runtime = globalThis as typeof globalThis & {
      __holoQueueJobDispatcher__?: unknown
      __holoQueueJobSyncDispatcher__?: unknown
    }
    const existingDispatcher = runtime.__holoQueueJobDispatcher__
    const existingSyncDispatcher = runtime.__holoQueueJobSyncDispatcher__
    const job = defineJob({
      async handle(payload: { readonly userId: string }) {
        return payload.userId
      },
    })

    queueJobInternals.setQueueJobDefinitionName(job, 'users.digest')

    try {
      delete runtime.__holoQueueJobDispatcher__
      delete runtime.__holoQueueJobSyncDispatcher__

      expect(() => job.dispatch({
        userId: 'usr-1',
      })).toThrow('Job definitions cannot dispatch before the queue runtime is loaded.')

      expect(() => job.dispatchSync({
        userId: 'usr-1',
      })).toThrow('Job definitions cannot dispatch before the queue runtime is loaded.')
    } finally {
      runtime.__holoQueueJobDispatcher__ = existingDispatcher
      runtime.__holoQueueJobSyncDispatcher__ = existingSyncDispatcher
    }
  })

  it('rejects invalid job metadata and malformed definitions', () => {
    expect(() => defineJob({
      tries: 0,
      async handle() {},
    })).toThrow('Job tries must be greater than or equal to 1.')

    expect(() => defineJob({
      tries: 1.5,
      async handle() {},
    })).toThrow('Job tries must be an integer when provided.')

    expect(() => defineJob({
      timeout: -1,
      async handle() {},
    })).toThrow('Job timeout must be greater than or equal to 0.')

    expect(() => defineJob({
      timeout: 1.5,
      async handle() {},
    })).toThrow('Job timeout must be an integer when provided.')

    expect(() => defineJob({
      backoff: [5, -1],
      async handle() {},
    })).toThrow('Job backoff entry at index 1 must be greater than or equal to 0.')

    expect(() => defineJob({
      backoff: [5, 1.5],
      async handle() {},
    })).toThrow('Job backoff entry at index 1 must be an integer.')

    expect(() => defineJob({
      async handle() {},
      backoff: 'later' as never,
    })).toThrow('Job backoff must be a number or an array of integers.')

    expect(() => defineJob({
      onCompleted: 'done' as never,
      async handle() {},
    })).toThrow('Job onCompleted hook must be a function when provided.')

    expect(() => defineJob({
      onFailed: 'failed' as never,
      async handle() {},
    })).toThrow('Job onFailed hook must be a function when provided.')

    expect(() => defineJob({
      handle: 'not-a-function',
    } as never)).toThrow('Jobs must define a "handle" function.')
  })

  it('exposes normalization helpers for internal contract consumers', () => {
    expect(normalizeQueueJobDefinition({
      queue: 'emails',
      async handle() {},
    }).queue).toBe('emails')
    expect(queueJobInternals.normalizeOptionalString(undefined, 'Job queue')).toBeUndefined()
    expect(() => queueJobInternals.normalizeOptionalString('   ', 'Job queue')).toThrow(
      'Job queue must be a non-empty string when provided.',
    )
    expect(queueJobInternals.normalizeOptionalInteger(undefined, 'Job timeout')).toBeUndefined()
    expect(queueJobInternals.normalizeBackoff(undefined)).toBeUndefined()
    expect(queueJobInternals.normalizeOptionalHook(undefined, 'Job onCompleted hook')).toBeUndefined()
    expect(queueJobInternals.normalizeBackoff(0)).toBe(0)
  })

  it('resolves cloned job definitions by full and option fingerprints', () => {
    queueJobInternals.clearQueueJobDefinitionNames()
    const handler = async (payload: { readonly id: string }) => payload.id
    const registered = defineJob({ queue: 'reports', handle: handler })
    queueJobInternals.setQueueJobDefinitionName(registered, 'reports.full')

    const fullClone = defineJob({ queue: 'reports', handle: handler })
    expect(queueJobInternals.resolveQueueJobDefinitionName(fullClone)).toBe('reports.full')

    const optionClone = defineJob({
      queue: 'reports',
      async handle(payload: { readonly id: string }) {
        return payload.id.toUpperCase()
      },
    })
    expect(queueJobInternals.resolveQueueJobDefinitionName(optionClone)).toBe('reports.full')

    queueJobInternals.deleteQueueJobDefinitionName('reports.full')
    expect(() => queueJobInternals.resolveQueueJobDefinitionName(fullClone)).toThrow('cannot dispatch before the job is registered')
  })

  it('rejects ambiguous cloned definitions and ignores non-job fingerprint registration', () => {
    queueJobInternals.clearQueueJobDefinitionNames()
    const handler = async () => 'done'
    const first = defineJob({ handle: handler })
    const second = defineJob({ handle: handler })
    queueJobInternals.setQueueJobDefinitionName(first, 'jobs.first')
    queueJobInternals.setQueueJobDefinitionName(second, 'jobs.second')
    queueJobInternals.setQueueJobDefinitionName({}, 'plain.object')

    expect(() => queueJobInternals.resolveQueueJobDefinitionName(defineJob({ handle: handler })))
      .toThrow('dispatch is ambiguous')
    expect(() => queueJobInternals.resolveQueueJobDefinitionName({})).toThrow('cannot dispatch before the job is registered')

    queueJobInternals.deleteQueueJobDefinitionName('jobs.first')
    queueJobInternals.deleteQueueJobDefinitionName('jobs.second')
    queueJobInternals.deleteQueueJobDefinitionName('plain.object')
    queueJobInternals.clearQueueJobDefinitionNames()
  })
})
