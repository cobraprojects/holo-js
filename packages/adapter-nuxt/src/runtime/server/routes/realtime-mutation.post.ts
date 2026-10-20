import { defineEventHandler, useRuntimeConfig } from '#imports'
import { handleRealtimeMutationRequest } from '@holo-js/realtime/server'
import { realtimeDefinitions } from '#holo/realtime-definitions'
import { createWebRequest } from '../route-request'

export default defineEventHandler(async (event) => {
  return await handleRealtimeMutationRequest(await createWebRequest(event), {
    projectRoot: useRuntimeConfig().holo.projectRoot ?? process.cwd(),
    definitions: realtimeDefinitions,
  })
})
