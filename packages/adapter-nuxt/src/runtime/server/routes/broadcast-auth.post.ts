import { defineEventHandler } from '#imports'
import { renderBroadcastAuthResponse } from '@holo-js/broadcast/auth'
import { holo } from '../../composables'
import { createWebRequest } from '../route-request'

type BroadcastSigning = {
  readonly appKey?: string
  readonly appSecret?: string
}

function resolveBroadcastSigning(connection: unknown): BroadcastSigning {
  if (!connection || typeof connection !== 'object') {
    return {}
  }

  const candidate = connection as Readonly<Record<string, unknown>>
  if (
    candidate.driver !== 'holo'
    || typeof candidate.key !== 'string'
    || typeof candidate.secret !== 'string'
  ) {
    return {}
  }

  return {
    appKey: candidate.key,
    appSecret: candidate.secret,
  }
}

export default defineEventHandler(async (event) => {
  const app = await holo.getApp()
  const auth = await holo.getAuth()
  const broadcast = app.config?.broadcast
  const connection = broadcast ? broadcast.connections[broadcast.default] : undefined
  const signing = resolveBroadcastSigning(connection)

  return await renderBroadcastAuthResponse(await createWebRequest(event), {
    ...signing,
    resolveUser: async (_request, context) => {
      const guardAuth = context.guard ? auth?.guard(context.guard) : undefined
      return guardAuth ? await guardAuth.user() : await auth?.user()
    },
    channelAuth: {
      registry: {
        projectRoot: app.projectRoot,
        channels: app.registry?.channels ?? [],
      },
    },
  })
})
