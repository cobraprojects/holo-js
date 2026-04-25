import {
  configureHoloRuntimeConfig,
} from '../composables'
import { initializeHoloAdapterProject } from '@holo-js/core'
import { useRuntimeConfig } from 'nitropack/runtime/config'
import { defineNitroPlugin } from 'nitropack/runtime/plugin'

export default defineNitroPlugin(async (nitroApp: { hooks: { hook: (name: string, handler: () => Promise<void>) => void } }) => {
  const config = useRuntimeConfig()
  configureHoloRuntimeConfig(config)

  const project = await initializeHoloAdapterProject(config.holo.projectRoot?.trim() || process.cwd(), {
    envName: config.holo.appEnv,
    preferCache: process.env.NODE_ENV === 'production',
    processEnv: process.env,
  })
  const driver = project.runtime.manager.connection().getDriver()

  // eslint-disable-next-line no-console -- startup confirmation is intentional
  console.log(`✅ Holo DB connected (${driver})`)

  nitroApp.hooks.hook('close', async () => {
    try {
      await project.runtime.shutdown()
    } catch {
      // Already disconnected
    }
  })
})
