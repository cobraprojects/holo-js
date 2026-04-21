import { basename, extname } from 'node:path'
import { loadConfigDirectory } from '@holo-js/config'
import {
  loadGeneratedProjectRegistry,
  loadProjectConfig,
  prepareProjectDiscovery,
  resolveProjectPackageImportSpecifier,
} from './project'
import { importProjectModule } from './project/runtime'
import { writeLine } from './io'
import type { IoStreams } from './cli-types'

type BroadcastCliModule = {
  startBroadcastWorker(bindings: {
    config: Awaited<ReturnType<typeof loadConfigDirectory>>['broadcast']
    queue?: Awaited<ReturnType<typeof loadConfigDirectory>>['queue']
    redis?: Awaited<ReturnType<typeof loadConfigDirectory>>['redis']
    channelAuth?: {
      registry?: {
        projectRoot: string
        channels: readonly {
          sourcePath: string
          pattern: string
          exportName?: string
          type: 'private' | 'presence'
          params: readonly string[]
          whispers: readonly string[]
        }[]
      }
      importModule?: (absolutePath: string) => Promise<unknown>
    }
  }): Promise<{
    host: string
    port: number
    stop(): Promise<void>
  }>
}

function hasLoadedRedisConfigSection(loadedFiles: readonly string[] | undefined): boolean {
  return Array.isArray(loadedFiles) && loadedFiles.some((filePath) => {
    return basename(filePath, extname(filePath)) === 'redis'
  })
}

export async function loadBroadcastCliModule(projectRoot: string): Promise<BroadcastCliModule> {
  try {
    return await import(resolveProjectPackageImportSpecifier(projectRoot, '@holo-js/broadcast')) as BroadcastCliModule
  } catch (error) {
    /* v8 ignore next -- defensive String(error) fallback for non-Error throws */
    const details = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Unable to load @holo-js/broadcast from ${projectRoot}. Install it with "holo install broadcast". ${details}`,
    )
  }
}

export async function runBroadcastWorkCommand(
  io: IoStreams,
  projectRoot: string,
  dependencies: {
    loadConfig?: typeof loadConfigDirectory
    loadModule?: typeof loadBroadcastCliModule
    loadRegistry?: typeof loadGeneratedProjectRegistry
  } = {},
): Promise<void> {
  const loadConfig = dependencies.loadConfig ?? loadConfigDirectory
  const loadModule = dependencies.loadModule ?? loadBroadcastCliModule
  const config = await loadConfig(projectRoot)
  const project = await loadProjectConfig(projectRoot)
  const loadRegistry = dependencies.loadRegistry ?? loadGeneratedProjectRegistry
  await loadRegistry(projectRoot).catch(() => undefined)
  const registry = await prepareProjectDiscovery(projectRoot, project.config)
  const broadcastModule = await loadModule(projectRoot)
  const worker = await broadcastModule.startBroadcastWorker({
    config: config.broadcast,
    queue: config.queue,
    ...(hasLoadedRedisConfigSection(config.loadedFiles)
      ? { redis: config.redis }
      : {}),
    ...(registry
      ? {
        channelAuth: {
          registry: {
            projectRoot,
            channels: registry.channels,
          },
          importModule: async (absolutePath: string) => await importProjectModule(projectRoot, absolutePath),
        },
      }
      : {}),
  })

  writeLine(io.stdout, `[broadcast] Worker listening on ${worker.host}:${worker.port}`)

  await new Promise<void>((resolvePromise) => {
    let stopped = false
    const stop = async () => {
      if (stopped) {
        return
      }

      stopped = true
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      await worker.stop()
      resolvePromise()
    }

    const onSignal = () => {
      void stop()
    }

    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
  })
}
