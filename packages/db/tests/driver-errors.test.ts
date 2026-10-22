import { describe, expect, it } from 'vitest'
import { DatabaseError, holoRuntimeInternals } from '../src'

const { driverErrorCodes, isDatabaseDeadlockError } = holoRuntimeInternals

function driverError(code: string, cause?: unknown): Error & { readonly code: string } {
  return Object.assign(new Error(`driver error ${code}`), { code, cause })
}

function wrapped(cause: unknown): DatabaseError {
  return new DatabaseError('Connection "main" failed to execute via driver "mysql": driver error', 'DRIVER_EXECUTE_ERROR', cause)
}

describe('isDatabaseDeadlockError', () => {
  it.each([
    ['a MySQL deadlock', driverError('ER_LOCK_DEADLOCK')],
    ['a PostgreSQL deadlock', driverError('40P01')],
    ['a PostgreSQL serialization failure', driverError('40001')],
  ])('recognizes %s', (_name, error) => {
    expect(isDatabaseDeadlockError(error)).toBe(true)
  })

  it.each([
    ['a DatabaseError wrapping a MySQL deadlock', wrapped(driverError('ER_LOCK_DEADLOCK'))],
    ['a DatabaseError wrapping a PostgreSQL deadlock', wrapped(driverError('40P01'))],
    ['a deadlock two causes deep', wrapped(new DatabaseError('outer', 'DRIVER_EXECUTE_ERROR', wrapped(driverError('40P01'))))],
  ])('recognizes %s through the cause chain', (_name, error) => {
    expect(isDatabaseDeadlockError(error)).toBe(true)
  })

  it.each([
    ['a lock wait timeout', driverError('ER_LOCK_WAIT_TIMEOUT')],
    ['a unique violation', driverError('23505')],
    ['a DatabaseError wrapping a unique violation', wrapped(driverError('ER_DUP_ENTRY'))],
    ['a plain error', new Error('connection reset')],
    ['a non-error value', 'ER_LOCK_DEADLOCK'],
    ['nothing', undefined],
  ])('does not treat %s as a deadlock', (_name, error) => {
    expect(isDatabaseDeadlockError(error)).toBe(false)
  })

  it('stops following a cause cycle without a deadlock', () => {
    const first: { code?: string, cause?: unknown } = { code: 'DRIVER_EXECUTE_ERROR' }
    const second: { code?: string, cause?: unknown } = { code: 'DRIVER_EXECUTE_ERROR', cause: first }
    first.cause = second
    expect(isDatabaseDeadlockError(first)).toBe(false)
  })

  it('does not look past the depth bound', () => {
    let error: unknown = driverError('40P01')
    for (let depth = 0; depth < 20; depth += 1) {
      error = new DatabaseError('wrapper', 'DRIVER_EXECUTE_ERROR', error)
    }
    expect(isDatabaseDeadlockError(error)).toBe(false)
  })
})

describe('driverErrorCodes', () => {
  it('collects driver codes from the error and its cause chain, outermost first', () => {
    expect(driverErrorCodes(wrapped(driverError('ER_NO_SUCH_TABLE')))).toEqual(['DRIVER_EXECUTE_ERROR', 'ER_NO_SUCH_TABLE'])
  })

  it('returns nothing for values without codes and stops at a cycle', () => {
    expect(driverErrorCodes(new Error('plain'))).toEqual([])
    const looped: { code: string, cause?: unknown } = { code: 'LOOP' }
    looped.cause = looped
    expect(driverErrorCodes(looped)).toEqual(['LOOP'])
  })
})
