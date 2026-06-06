import { defineEventHandler } from 'h3'
import { renderBroadcastClientConfigResponse } from '@holo-js/broadcast/client-config'
import { holo } from '../../composables'

export default defineEventHandler(async () => {
  const app = await holo.getApp()
  return renderBroadcastClientConfigResponse(app.config.broadcast)
})
