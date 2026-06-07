import { defineEventHandler, getHeaders, getRequestURL, readRawBody } from 'h3'
import { renderBroadcastAuthResponse } from '@holo-js/broadcast/auth'
import { holo } from '../../composables'

export default defineEventHandler(async (event) => {
  const app = await holo.getApp()
  const auth = await holo.getAuth()
  const connection = app.config.broadcast.connections[app.config.broadcast.default]
  const signing = connection?.driver === 'holo' && 'key' in connection && 'secret' in connection
    ? {
        appKey: connection.key,
        appSecret: connection.secret,
      }
    : {}
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
