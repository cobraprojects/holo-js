import { renderBroadcastAuthResponse } from '@holo-js/broadcast/auth'
import { holo } from '$lib/server/holo'

export async function POST({ request }: { request: Request }) {
  const app = await holo.getApp()
  const auth = await holo.getAuth()

  return await renderBroadcastAuthResponse(request, {
    resolveUser: async () => await auth?.user(),
    channelAuth: {
      registry: {
        projectRoot: app.projectRoot,
        channels: app.registry?.channels ?? [],
      },
    },
  })
}
