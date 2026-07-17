import { describe, expect, it } from 'vitest'
import { createDialect } from '@holo-js/db'
import { queueDatabaseInternals } from '../src'

describe('@holo-js/queue-db database contracts', () => {
  it('validates every supported JSON value shape and rejects unsafe values', () => {
    expect(queueDatabaseInternals.serializeQueueJson(null)).toBe('null')
    expect(queueDatabaseInternals.serializeQueueJson('value')).toBe('"value"')
    expect(queueDatabaseInternals.serializeQueueJson(true)).toBe('true')
    expect(queueDatabaseInternals.serializeQueueJson(42)).toBe('42')
    expect(queueDatabaseInternals.serializeQueueJson([1, 'two', false])).toBe('[1,"two",false]')

    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { ok: true })
    expect(queueDatabaseInternals.serializeQueueJson(nullPrototype)).toBe('{"ok":true}')

    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, undefined, () => undefined, Symbol('value'), 1n]) {
      expect(() => queueDatabaseInternals.serializeQueueJson(value)).toThrow('must be JSON-serializable')
    }
    expect(() => queueDatabaseInternals.serializeQueueJson(new Date())).toThrow('plain JSON object')

    const circularArray: unknown[] = []
    circularArray.push(circularArray)
    expect(() => queueDatabaseInternals.serializeQueueJson(circularArray)).toThrow('circular reference')

    const circularObject: Record<string, unknown> = {}
    circularObject.self = circularObject
    expect(() => queueDatabaseInternals.serializeQueueJson(circularObject)).toThrow('circular reference')
  })

  it('normalizes identifiers, placeholders, strings, and integers', () => {
    const dialect = createDialect('sqlite')
    expect(queueDatabaseInternals.normalizeIdentifierPath(' queue.jobs ', 'Table')).toBe('queue.jobs')
    expect(queueDatabaseInternals.quoteIdentifierPath(dialect, 'queue.jobs')).toBe('"queue"."jobs"')
    expect(queueDatabaseInternals.createPlaceholderList(dialect, 2, 3)).toBe('?, ?')
    expect(() => queueDatabaseInternals.normalizeIdentifierPath(' ', 'Table')).toThrow('non-empty string')
    expect(() => queueDatabaseInternals.normalizeIdentifierPath('queue.bad-name', 'Table')).toThrow('valid SQL identifier')
    expect(() => queueDatabaseInternals.createPlaceholderList(dialect, 0)).toThrow('at least one binding')

    expect(queueDatabaseInternals.coerceRequiredString('job', 'Job')).toBe('job')
    expect(() => queueDatabaseInternals.coerceRequiredString('', 'Job')).toThrow('non-empty string')
    expect(() => queueDatabaseInternals.coerceRequiredString(1, 'Job')).toThrow('non-empty string')
    expect(queueDatabaseInternals.coerceRequiredInteger(4, 'Attempts')).toBe(4)
    expect(queueDatabaseInternals.coerceRequiredInteger('-4', 'Attempts')).toBe(-4)
    expect(() => queueDatabaseInternals.coerceRequiredInteger(1.5, 'Attempts')).toThrow('must be an integer')
    expect(() => queueDatabaseInternals.coerceRequiredInteger('1.5', 'Attempts')).toThrow('must be an integer')
    expect(queueDatabaseInternals.coerceOptionalInteger(null, 'Available at')).toBeUndefined()
    expect(queueDatabaseInternals.coerceOptionalInteger(undefined, 'Available at')).toBeUndefined()
    expect(queueDatabaseInternals.coerceOptionalInteger('5', 'Available at')).toBe(5)
  })

  it('parses stored queue and failed-job rows', () => {
    const envelope = {
      id: 'job-1',
      name: 'reports.generate',
      connection: 'database',
      queue: 'reports',
      payload: { reportId: 'report-1' },
      attempts: '1',
      maxAttempts: 3,
      availableAt: null,
      createdAt: '100',
    }
    expect(queueDatabaseInternals.parseStoredQueueEnvelope(envelope)).toMatchObject({
      id: 'job-1',
      attempts: 1,
      maxAttempts: 3,
    })
    expect(queueDatabaseInternals.parseStoredQueueEnvelope({ ...envelope, availableAt: '120' }))
      .toMatchObject({ availableAt: 120 })
    expect(() => queueDatabaseInternals.parseStoredQueueEnvelope([])).toThrow('must serialize a queue job envelope object')

    const storedRow = {
      id: 'job-1',
      job: 'reports.generate',
      connection: 'database',
      queue: 'reports',
      payload: '{"reportId":"report-1"}',
      attempts: 1,
      max_attempts: 3,
      available_at: null,
      created_at: 100,
    }
    expect(queueDatabaseInternals.parseStoredQueueJobRow(storedRow)).toMatchObject({ id: 'job-1' })
    expect(queueDatabaseInternals.parseStoredFailedQueueJobRow({
      id: 'failed-1',
      job_id: 'job-1',
      payload: JSON.stringify(envelope),
      exception: 'failed',
      failed_at: 200,
    })).toMatchObject({ id: 'failed-1', jobId: 'job-1', failedAt: 200 })
    expect(() => queueDatabaseInternals.parseStoredPayload('{broken', 'Payload')).toThrow()
  })
})
