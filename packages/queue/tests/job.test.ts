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
})
