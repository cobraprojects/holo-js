import {
  createNuxtAuthRequestAccessors,
  configureHoloRuntimeConfig,
} from '../composables'
import { createNuxtAuthorizationError } from '../authorization-error'
import { connectionAddress } from '../server/connection-address'
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
  requestUrlInternals.provideConnectionAddress(() => connectionAddress(useEvent().node.req.socket))

  const project = initializeHoloAdapterProject(config.holo.projectRoot?.trim() || process.cwd(), {
    processEnv: process.env,
    authRequest: createNuxtAuthRequestAccessors(),
    authorizationError: {
      createError: createNuxtAuthorizationError,
    },
  })
  let projectPending = true
  const markProjectSettled = () => {
    projectPending = false
  }
  const projectSettled = project.then(markProjectSettled, markProjectSettled)

  const onRequest = nitroApp.h3App.options.onRequest
  nitroApp.h3App.options.onRequest = async (event) => {
    await project
    return await onRequest?.(event)
  }

  const shutdownProject = async () => {
    try {
      await (await project).runtime.shutdown()
    } catch {
      return
    }
  }

  nitroApp.hooks.hook('close', async () => {
    if (projectPending) {
      void projectSettled.then(shutdownProject)
      return
    }
    await shutdownProject()
  })
})
