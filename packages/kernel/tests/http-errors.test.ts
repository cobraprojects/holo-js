import { describe, expect, it } from 'vitest'
import { isHoloHttpErrorStatus, normalizeHoloHttpError } from '../src'

describe('@holo-js/kernel HTTP errors', () => {
  it('recognizes supported statuses and normalizes common error shapes', () => {
    const cause = Object.assign(new Error('Unauthorized'), { status: 401, code: 'AUTH_REQUIRED' })

    expect(isHoloHttpErrorStatus(401)).toBe(true)
    expect(isHoloHttpErrorStatus(399)).toBe(false)
    expect(normalizeHoloHttpError(cause)).toEqual({
      status: 401,
      message: 'Unauthorized',
      code: 'AUTH_REQUIRED',
      cause,
    })
    expect(normalizeHoloHttpError({ statusCode: 404, statusText: 'Not Found' })).toMatchObject({
      status: 404,
      message: 'Not Found',
    })
    expect(normalizeHoloHttpError({ digest: 'NEXT_HTTP_ERROR_FALLBACK;403', message: 'Forbidden' })).toMatchObject({
      status: 403,
      message: 'Forbidden',
    })
  })

  it('rejects unsupported shapes and supplies a safe fallback message', () => {
    expect(normalizeHoloHttpError(undefined)).toBeUndefined()
    expect(normalizeHoloHttpError({ status: 200 })).toBeUndefined()
    expect(normalizeHoloHttpError({ status: 400.5 })).toBeUndefined()
    expect(normalizeHoloHttpError({ status: 400, message: '' })).toMatchObject({
      status: 400,
      message: 'An unexpected error occurred.',
    })
    expect(normalizeHoloHttpError({ status: 400, message: 'Bad Request', code: '' })).toMatchObject({
      status: 400,
      message: 'Bad Request',
      code: undefined,
    })
    expect(normalizeHoloHttpError({ status: 0, statusCode: 418 })).toMatchObject({ status: 418 })
    expect(normalizeHoloHttpError({ digest: 'invalid' })).toBeUndefined()
  })
})
