import {
  createNuxtAuthRequestAccessors,
  configureHoloRuntimeConfig,
} from '../composables'
import { createNuxtAuthorizationError } from '../authorization-error'
import { initializeHoloAdapterProject } from '@holo-js/core'
import { useRuntimeConfig } from 'nitropack/runtime/config'
import { defineNitroPlugin } from 'nitropack/runtime/plugin'

export default defineNitroPlugin((nitroApp: { hooks: { hook: (name: string, handler: () => Promise<void>) => void } }) => {
  const config = useRuntimeConfig()
  configureHoloRuntimeConfig(config)

  const project = initializeHoloAdapterProject(config.holo.projectRoot?.trim() || process.cwd(), {
    envName: config.holo.appEnv,
    preferCache: process.env.NODE_ENV === 'production',
    processEnv: process.env,
    authRequest: createNuxtAuthRequestAccessors(),
    authorizationError: {
      createError: createNuxtAuthorizationError,
    },
  })

  nitroApp.hooks.hook('request', async () => {
    await project
  })

  nitroApp.hooks.hook('close', async () => {
    try {
      await (await project).runtime.shutdown()
    } catch {
      return
    }
  })
})
