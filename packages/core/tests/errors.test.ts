import { describe, expect, it } from 'vitest'
import { isHoloHttpErrorStatus, normalizeHoloHttpError } from '../src/errors'

describe('@holo-js/core errors', () => {
  it('normalizes status-bearing errors without importing framework code', () => {
    const error = Object.assign(new Error('Only admins can update posts.'), {
      status: 403,
      code: 'posts.update.denied',
    })

    expect(normalizeHoloHttpError(error)).toEqual({
      status: 403,
      message: 'Only admins can update posts.',
      code: 'posts.update.denied',
      cause: error,
    })
  })

  it('normalizes statusCode-bearing framework errors', () => {
    const error = {
      statusCode: 422,
      message: 'The title field is required.',
    }

    expect(normalizeHoloHttpError(error)).toEqual({
      status: 422,
      message: 'The title field is required.',
      cause: error,
    })
  })

  it('normalizes Next HTTP access fallback digests', () => {
    const error = Object.assign(new Error('Forbidden'), {
      digest: 'NEXT_HTTP_ERROR_FALLBACK;403',
    })

    expect(normalizeHoloHttpError(error)).toEqual({
      status: 403,
      message: 'Forbidden',
      cause: error,
    })
  })

  it('ignores non-HTTP errors', () => {
    expect(normalizeHoloHttpError(new Error('Connection closed.'))).toBeUndefined()
    expect(normalizeHoloHttpError({ status: 200, message: 'OK' })).toBeUndefined()
  })

  it('recognizes client and server HTTP error statuses', () => {
    expect(isHoloHttpErrorStatus(401)).toBe(true)
    expect(isHoloHttpErrorStatus(500)).toBe(true)
    expect(isHoloHttpErrorStatus(302)).toBe(false)
  })
})
