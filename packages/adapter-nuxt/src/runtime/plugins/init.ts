import {
  createNuxtAuthRequestAccessors,
  configureHoloRuntimeConfig,
} from '../composables'
import { createNuxtAuthorizationError } from '../authorization-error'
import { initializeHoloAdapterProject } from '@holo-js/core'
import { requestUrlInternals } from '@holo-js/kernel'
import type { H3Event } from 'h3'
import { defineNitroPlugin, useEvent, useRuntimeConfig } from '#imports'

type NitroApp = {
  h3App: {
    options: {
      onRequest?: (event: H3Event) => void | Promise<void>
    }
  }
  hooks: {
    hook(name: 'close', handler: () => Promise<void>): void
  }
}

export default defineNitroPlugin((nitroApp: NitroApp) => {
  const config = useRuntimeConfig()
  configureHoloRuntimeConfig(config)
  requestUrlInternals.provideConnectionAddress(() => useEvent().node.req.socket.remoteAddress)

  const project = initializeHoloAdapterProject(config.holo.projectRoot?.trim() || process.cwd(), {
    envName: config.holo.appEnv,
    preferCache: process.env.NODE_ENV === 'production',
    processEnv: process.env,
    authRequest: createNuxtAuthRequestAccessors(),
    authorizationError: {
      createError: createNuxtAuthorizationError,
    },
  })

  const onRequest = nitroApp.h3App.options.onRequest
  nitroApp.h3App.options.onRequest = async (event) => {
    await project
    return await onRequest?.(event)
  }

  nitroApp.hooks.hook('close', async () => {
    try {
      await (await project).runtime.shutdown()
    } catch {
      return
    }
  })
})
