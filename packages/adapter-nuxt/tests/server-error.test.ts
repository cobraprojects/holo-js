import { afterEach, describe, expect, it, vi } from 'vitest'
import { ValidationException } from '@holo-js/validation'
import type { H3Error, H3Event } from 'h3'

type H3ErrorJson = Pick<H3Error<unknown>, 'data' | 'message' | 'statusCode' | 'statusMessage'>

function createH3Error(error: Error, statusCode = 500): H3Error {
  const serializable = error as Error & { readonly toJSON?: () => unknown }
  const originalToJSON = typeof serializable.toJSON === 'function'
    ? serializable.toJSON.bind(error)
    : undefined
  const toJSON = (): H3ErrorJson => originalToJSON
    ? originalToJSON() as H3ErrorJson
    : ({
      message: error.message,
      statusCode,
    })

  return Object.assign(error, {
    statusCode,
    fatal: false,
    unhandled: false,
    toJSON,
  })
}

async function loadErrorHandler() {
  const send = vi.fn(async () => undefined)
  const setHeader = vi.fn()
  const setResponseStatus = vi.fn()

  vi.resetModules()
  vi.doMock('h3', () => ({
    send,
    setHeader,
    setResponseStatus,
  }))
  const { default: handler } = await import('../src/runtime/server/error')
  return {
    handler,
    send,
    setHeader,
    setResponseStatus,
  }
}

afterEach(() => {
  vi.resetModules()
  vi.doUnmock('h3')
})

describe('Nuxt validation error handler', () => {
  it('ignores errors without a validation exception in their cause chain', async () => {
    const { handler, send, setHeader, setResponseStatus } = await loadErrorHandler()
    const event = {} as H3Event
    await expect(handler(createH3Error(new Error('ordinary')), event)).resolves.toBeUndefined()
    await expect(handler(createH3Error(new Error('wrapped', { cause: null })), event)).resolves.toBeUndefined()
    expect(send).not.toHaveBeenCalled()
    expect(setHeader).not.toHaveBeenCalled()
    expect(setResponseStatus).not.toHaveBeenCalled()
  })

  it('serializes validation exceptions wrapped by Nitro error causes', async () => {
    const { handler, send, setHeader, setResponseStatus } = await loadErrorHandler()
    const validationError = ValidationException.withMessages({
      email: ['These credentials do not match our records.'],
      password: ['These credentials do not match our records.'],
    })
    const event = {
      get handled() {
        return true
      },
    } as H3Event

    await handler(createH3Error(new Error(validationError.message, { cause: validationError })), event)

    expect(setResponseStatus).toHaveBeenCalledWith(event, 422)
    expect(setHeader).toHaveBeenCalledWith(event, 'content-type', 'application/json; charset=utf-8')
    expect(send).toHaveBeenCalledWith(
      event,
      JSON.stringify(validationError.toJSON()),
      'application/json',
    )
  })

  it('redirects browser form validation failures with flashed errors', async () => {
    const { handler, send, setHeader, setResponseStatus } = await loadErrorHandler()
    const validationError = ValidationException.withMessages({
      image: ['The selected file must be 2 MB or smaller.'],
    })
    const responseHeaders = new Map<string, number | string | readonly string[]>()
    const event = {
      path: '/admin/posts/create',
      node: {
        req: {
          method: 'POST',
          headers: {
            accept: 'text/html',
            host: 'app.test',
            referer: 'https://app.test/admin/posts/new',
          },
        },
        res: {
          statusCode: 422,
          statusMessage: 'Unprocessable Content',
          getHeader: (name: string) => responseHeaders.get(name),
          setHeader: (name: string, value: number | string | readonly string[]) => {
            responseHeaders.set(name, value)
          },
        },
      },
    }

    await handler(createH3Error(validationError, 422), event as H3Event)

    expect(setResponseStatus).not.toHaveBeenCalled()
    expect(setHeader).not.toHaveBeenCalled()
    expect(event.node.res.statusCode).toBe(303)
    expect(event.node.res.statusMessage).toBe('See Other')
    expect(responseHeaders.get('location')).toBe('/admin/posts/new')
    expect(String(responseHeaders.get('content-type'))).toBe('text/html; charset=utf-8')
    expect(String(responseHeaders.get('set-cookie'))).toContain('holo_form_failure=')
    expect(send).toHaveBeenCalledWith(event, '', 'text/html')
  })
})
