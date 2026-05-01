import { holo } from '$lib/server/holo'
import { createPublicStorageResponse } from '@holo-js/storage'

export async function GET({ request }: { request: Request }) {
  const app = await holo.getApp()
  return createPublicStorageResponse(app.projectRoot, app.config.storage, request)
}
