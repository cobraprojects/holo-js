import { cookies, headers } from 'next/headers'
import { initializeHolo, type CreateHoloOptions } from '@holo-js/core'
import type { DotPath, HoloConfigMap, LoadedHoloConfig, ValueAtPath } from '@holo-js/config'
import { getCurrentNextRequest } from './request-context'
export { runWithNextRequest, type NextRequestLike } from './request-context'

export type NextHoloRuntimeOptions = CreateHoloOptions & {
  readonly projectRoot: string
}

function resolveNextAuthRequestAccessors(): NonNullable<CreateHoloOptions['authRequest']> {
  return {
    async getCookie(name: string) {
      const request = getCurrentNextRequest()
      if (request) {
        return request.cookies.get(name)?.value
      }

      const store = await cookies()
      return store.get(name)?.value
    },
    async getHeader(name: string) {
      const request = getCurrentNextRequest()
      if (request) {
        return request.headers.get(name) ?? undefined
      }

      const requestHeaders = await headers()
      return requestHeaders.get(name) ?? undefined
    },
  }
}

export function createNextHoloHelpers<TCustom extends HoloConfigMap = HoloConfigMap>(
  options: NextHoloRuntimeOptions,
) {
  const resolveRuntime = async () => await initializeHolo<TCustom>(options.projectRoot, {
    ...options,
    authRequest: options.authRequest ?? resolveNextAuthRequestAccessors(),
  })

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
