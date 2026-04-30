import { initializeHolo, type CreateHoloOptions } from '@holo-js/core/runtime'
import type { DotPath, HoloConfigMap, LoadedHoloConfig, ValueAtPath } from '@holo-js/config'

export type NextHoloRuntimeOptions = CreateHoloOptions & {
  readonly projectRoot: string
}

export function createNextHoloHelpers<TCustom extends HoloConfigMap = HoloConfigMap>(
  options: NextHoloRuntimeOptions,
) {
  const resolveRuntime = async () => await initializeHolo<TCustom>(options.projectRoot, options)

  const useConfig = async <TPath extends DotPath<LoadedHoloConfig<TCustom>['all']>>(
    path: TPath,
  ): Promise<ValueAtPath<LoadedHoloConfig<TCustom>['all'], TPath>> => {
    const runtime = await resolveRuntime()
    return runtime.config(path)
  }

  return {
    async getApp() {
      const runtime = await resolveRuntime()
      return {
        projectRoot: runtime.projectRoot,
        config: runtime.loadedConfig,
        registry: runtime.registry,
        runtime,
      }
    },
    async getProject() {
      const runtime = await resolveRuntime()
      return {
        projectRoot: runtime.projectRoot,
        config: runtime.loadedConfig,
        registry: runtime.registry,
        runtime,
      }
    },
    async getSession() {
      const runtime = await resolveRuntime()
      return runtime.session
    },
    async getAuth() {
      const runtime = await resolveRuntime()
      return runtime.auth
    },
    useConfig,
    config: useConfig,
  }
}
