import { defineEventHandler, getHeaders, getRequestURL, readRawBody } from 'h3'
import { renderBroadcastAuthResponse } from '@holo-js/broadcast/auth'
import { holo } from '../../composables'

type BroadcastSigning = {
  readonly appKey?: string
  readonly appSecret?: string
}

function resolveBroadcastSigning(connection: unknown): BroadcastSigning {
  if (!connection || typeof connection !== 'object') {
    return {}
  }

  const candidate = connection as Readonly<Record<string, unknown>>
  if (
    candidate.driver !== 'holo'
    || typeof candidate.key !== 'string'
    || typeof candidate.secret !== 'string'
  ) {
    return {}
  }

  return {
    appKey: candidate.key,
    appSecret: candidate.secret,
  }
}

export default defineEventHandler(async (event) => {
  const app = await holo.getApp()
  const auth = await holo.getAuth()
  const broadcast = app.config?.broadcast
  const connection = broadcast ? broadcast.connections[broadcast.default] : undefined
  const signing = resolveBroadcastSigning(connection)
  const headers = new Headers()
  for (const [key, value] of Object.entries(getHeaders(event))) {
    if (typeof value === 'string') {
      headers.set(key, value)
    }
  }
  const request = new Request(getRequestURL(event), {
    method: event.method,
    headers,
    body: await readRawBody(event),
  })

  return await renderBroadcastAuthResponse(request, {
    ...signing,
    resolveUser: async (_request, context) => {
      const guardAuth = context.guard ? auth?.guard(context.guard) : undefined
      return guardAuth ? await guardAuth.user() : await auth?.user()
    },
    channelAuth: {
      registry: {
        projectRoot: app.projectRoot,
        channels: app.registry?.channels ?? [],
      },
    },
  })
})
