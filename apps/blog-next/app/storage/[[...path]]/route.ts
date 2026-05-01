import { holo } from '@/server/holo'
import { createPublicStorageResponse } from '@holo-js/storage'

export async function GET(request: Request) {
  const app = await holo.getApp()
  return createPublicStorageResponse(app.projectRoot, app.config.storage, request)
}
