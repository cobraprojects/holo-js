import { afterEach, describe, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'

afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
})

describe('@holo-js/adapter-nuxt realtime routes', () => {
  it('converts H3 events into web requests for realtime query handlers', async () => {
    const handleRealtimeQueryRequest = vi.fn(async (request: Request, options: { readonly projectRoot: string }) => {
      return Response.json({
        body: await request.json(),
        contentType: request.headers.get('content-type'),
        method: request.method,
        projectRoot: options.projectRoot,
        url: request.url,
      })
    })

    vi.doMock('h3', () => ({
      defineEventHandler: (handler: unknown) => handler,
      getHeaders: () => ({
        'content-type': 'application/json',
        ignored: ['not-string'],
      }),
      getRequestURL: () => new URL('http://localhost/holo/realtime/query'),
      readRawBody: async () => JSON.stringify({ name: 'posts.list', args: { limit: 2 } }),
    }))
    vi.doMock('@holo-js/realtime/server', () => ({
      handleRealtimeQueryRequest,
    }))
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('useRuntimeConfig', () => ({
      holo: {
        projectRoot: '/project',
      },
    }))

    const route = await import('../src/runtime/server/routes/realtime-query.post')
    const response = await route.default({
      method: 'POST',
    } as H3Event)

    await expect(response.json()).resolves.toEqual({
      body: {
        name: 'posts.list',
        args: {
          limit: 2,
        },
      },
      contentType: 'application/json',
      method: 'POST',
      projectRoot: '/project',
      url: 'http://localhost/holo/realtime/query',
    })
    expect(handleRealtimeQueryRequest).toHaveBeenCalledTimes(1)
  })

  it('returns realtime handler responses unchanged', async () => {
    const forbiddenResponse = () => Response.json({
      error: 'Realtime access forbidden.',
    }, {
      status: 403,
    })
    const handleRealtimeQueryRequest = vi.fn(async () => forbiddenResponse())
    const handleRealtimeMutationRequest = vi.fn(async () => forbiddenResponse())
    const handleRealtimeStreamRequest = vi.fn(async () => forbiddenResponse())

    vi.doMock('h3', () => ({
      defineEventHandler: (handler: unknown) => handler,
      getHeaders: () => ({
        'content-type': 'application/json',
      }),
      getRequestURL: () => new URL('http://localhost/holo/realtime/query'),
      readRawBody: async () => JSON.stringify({ name: 'private.denied' }),
    }))
    vi.doMock('@holo-js/realtime/server', () => ({
      handleRealtimeMutationRequest,
      handleRealtimeQueryRequest,
      handleRealtimeStreamRequest,
    }))
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('useRuntimeConfig', () => ({
      holo: {
        projectRoot: '/project',
      },
    }))

    const queryRoute = await import('../src/runtime/server/routes/realtime-query.post')
    const mutationRoute = await import('../src/runtime/server/routes/realtime-mutation.post')
    const streamRoute = await import('../src/runtime/server/routes/realtime-stream.get')
    const queryResponse = await queryRoute.default({ method: 'POST' } as H3Event)
    const mutationResponse = await mutationRoute.default({ method: 'POST' } as H3Event)
    const streamResponse = await streamRoute.default({ method: 'GET' } as H3Event)

    expect(queryResponse.status).toBe(403)
    expect(mutationResponse.status).toBe(403)
    expect(streamResponse.status).toBe(403)
    await expect(queryResponse.json()).resolves.toEqual({
      error: 'Realtime access forbidden.',
    })
    expect(handleRealtimeQueryRequest).toHaveBeenCalledTimes(1)
    expect(handleRealtimeMutationRequest).toHaveBeenCalledTimes(1)
    expect(handleRealtimeStreamRequest).toHaveBeenCalledTimes(1)
  })
})
