import { createPublicStorageResponse } from '@holo-js/storage'
import type { H3Event } from 'h3'
import { defineEventHandler, getRequestURL, sendWebResponse } from '#imports'
import { holo } from '../../composables'

function createStorageRequest(event: H3Event): Request {
  return event.web?.request ?? new Request(getRequestURL(event, { xForwardedProto: false }), {
    method: event.method,
    headers: event.headers,
  })
}

export default defineEventHandler(async (event) => {
  const app = await holo.getApp()
  const response = await createPublicStorageResponse(app.projectRoot, app.config.storage, createStorageRequest(event), app.config.app.key)
  return sendWebResponse(event, response)
})
