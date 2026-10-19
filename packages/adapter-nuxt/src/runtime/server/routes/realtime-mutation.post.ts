import { defineEventHandler, useRuntimeConfig } from '#imports'
import { handleRealtimeMutationRequest } from '@holo-js/realtime/server'
import { realtimeDefinitions } from '#holo/realtime-definitions'
import { createRealtimeRequest } from './realtime-request'

export default defineEventHandler(async (event) => {
  return await handleRealtimeMutationRequest(await createRealtimeRequest(event), {
    projectRoot: useRuntimeConfig().holo.projectRoot ?? process.cwd(),
    definitions: realtimeDefinitions,
  })
})
