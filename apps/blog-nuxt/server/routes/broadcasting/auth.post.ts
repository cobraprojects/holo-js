import { defineEventHandler, getHeaders, getRequestURL, readRawBody } from 'h3'
import { renderBroadcastAuthResponse } from '@holo-js/broadcast/auth'
import { holo } from '#imports'

export default defineEventHandler(async (event) => {
  const app = await holo.getApp()
  const auth = await holo.getAuth()
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
    resolveUser: async () => await auth?.user(),
    channelAuth: {
      registry: {
        projectRoot: app.projectRoot,
        channels: app.registry?.channels ?? [],
      },
    },
  })
})
