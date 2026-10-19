import { defineEventHandler, useRuntimeConfig } from '#imports'
import { handleRealtimeQueryRequest } from '@holo-js/realtime/server'
import { realtimeDefinitions } from '#holo/realtime-definitions'
import { createRealtimeRequest } from './realtime-request'

export default defineEventHandler(async (event) => {
  return await handleRealtimeQueryRequest(await createRealtimeRequest(event), {
    projectRoot: useRuntimeConfig().holo.projectRoot ?? process.cwd(),
    definitions: realtimeDefinitions,
  })
})
