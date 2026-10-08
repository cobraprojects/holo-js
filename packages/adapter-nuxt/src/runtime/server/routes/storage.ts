import { createPublicStorageResponse } from '@holo-js/storage'
import { defineEventHandler, sendWebResponse, toWebRequest } from 'h3'
import { holo } from '../../composables'

export default defineEventHandler(async (event) => {
  const app = await holo.getApp()
  const response = await createPublicStorageResponse(app.projectRoot, app.config.storage, toWebRequest(event), app.config.app.key)
  return sendWebResponse(event, response)
})
