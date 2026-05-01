import { renderBroadcastAuthResponse } from '@holo-js/broadcast/auth'
import { holo } from '@/server/holo'

export async function POST(request: Request) {
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
