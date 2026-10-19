import { resolveProjectAppEnvironmentSync } from '@holo-js/config'
import type { RuntimeConnectionConfig, RuntimeDatabaseConfig } from '@holo-js/db'
import {
  createHoloProjectAccessors,
  getHolo,
  initializeHoloAdapterProject,
  type CreateHoloOptions,
} from '@holo-js/core'

type RuntimeConfigShape = {
  holo: {
    appUrl?: string
    projectRoot?: string
  }
}

type RuntimeGlobals = typeof globalThis & {
  __holoNuxtAuthRequestRunner?: <TValue>(accessors: NonNullable<CreateHoloOptions['authRequest']>, callback: () => TValue) => TValue
  __holoRuntimeConfig?: RuntimeConfigShape
  useRuntimeConfig?: () => RuntimeConfigShape
}

export type NuxtAuthRequestEvent = {
  readonly headers?: Pick<Headers, 'get'>
  readonly request?: {
    readonly headers?: Pick<Headers, 'get'>
  }
  readonly web?: {
    readonly request?: {
      readonly headers?: Pick<Headers, 'get'>
    }
  }
  readonly node?: {
    readonly req?: {
      readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>>
    }
    readonly res?: {
      statusCode: number
      getHeader(name: string): number | string | readonly string[] | undefined
      setHeader(name: string, value: number | string | readonly string[]): void
      end(): void
    }
  }
}

export function configureHoloRuntimeConfig(config: RuntimeConfigShape): void {
  const runtimeGlobals = globalThis as RuntimeGlobals
  runtimeGlobals.__holoRuntimeConfig = config
}

export function resetHoloRuntimeConfig(): void {
  const runtimeGlobals = globalThis as RuntimeGlobals
  delete runtimeGlobals.__holoRuntimeConfig
}

function getRuntimeConfig(): RuntimeConfigShape {
  const runtimeGlobals = globalThis as RuntimeGlobals

  if (runtimeGlobals.__holoRuntimeConfig) {
    return runtimeGlobals.__holoRuntimeConfig
  }

  if (typeof runtimeGlobals.useRuntimeConfig !== 'function') {
    throw new TypeError('Holo runtime config is not configured.')
  }

  return runtimeGlobals.useRuntimeConfig()
}

function resolveRuntimeProjectRoot(config: RuntimeConfigShape): string {
  return config.holo.projectRoot?.trim() || process.cwd()
}

async function resolveNitroEvent(): Promise<NuxtAuthRequestEvent | undefined> {
  const { useEvent } = await import('#imports')
  return useEvent()
}

export function createNuxtAuthRequestAccessors(requestEvent?: NuxtAuthRequestEvent) {
  function safeDecode(value: string): string | undefined {
    try {
      return decodeURIComponent(value)
    } catch {
      return undefined
    }
  }

  async function readHeader(name: string): Promise<string | undefined> {
    const event = requestEvent ?? (await resolveNitroEvent())

    if (!event) {
      return undefined
    }

    const normalizedName = name.toLowerCase()

    const headerSources = [event.headers, event.web?.request?.headers, event.request?.headers]
    for (const headers of headerSources) {
      if (headers && typeof headers.get === 'function') return headers.get(name) ?? undefined
    }

    const value = event.node?.req?.headers?.[normalizedName]
    if (Array.isArray(value)) {
      return value[0]
    }

    return typeof value === 'string' ? value : undefined
  }

  async function readCookie(name: string): Promise<string | undefined> {
    const header = await readHeader('cookie')
    if (!header) {
      return undefined
    }

    for (const segment of header.split(';')) {
      const trimmed = segment.trim()
      const separator = trimmed.indexOf('=')
      if (separator <= 0) {
        continue
      }

      const key = safeDecode(trimmed.slice(0, separator))
      if (typeof key === 'undefined') {
        continue
      }

      if (key !== name) {
        continue
      }

      const value = safeDecode(trimmed.slice(separator + 1))
      if (typeof value === 'undefined') {
        continue
      }

      return value
    }

    return undefined
  }

  async function appendCookie(cookie: string): Promise<void> {
    const event = requestEvent ?? (await resolveNitroEvent())
    const response = event?.node?.res
    if (!response) {
      return
    }

    const current = response.getHeader('set-cookie')
    if (Array.isArray(current)) {
      response.setHeader('set-cookie', [...current, cookie])
      return
    }

    if (typeof current === 'string') {
      response.setHeader('set-cookie', [current, cookie])
      return
    }

    response.setHeader('set-cookie', [cookie])
  }

  const getCookieValue: NonNullable<CreateHoloOptions['authRequest']>['getCookie'] = async (name) => {
    return await readCookie(name)
  }

  const getHeaderValue: NonNullable<CreateHoloOptions['authRequest']>['getHeader'] = async (name) => {
    return await readHeader(name)
  }

  const appendResponseCookie: NonNullable<CreateHoloOptions['authRequest']>['appendResponseCookie'] = async (cookie) => {
    await appendCookie(cookie)
  }

  const redirectResponse: NonNullable<CreateHoloOptions['authRequest']>['redirectResponse'] = async (url, status) => {
    const event = requestEvent ?? (await resolveNitroEvent())
    const response = event?.node?.res
    if (!response) {
      throw new TypeError('Holo Nuxt auth redirect requires an active Nitro event.')
    }

    response.statusCode = status ?? 302
    response.setHeader('location', url)
    response.end()
  }

  return {
    getCookie: getCookieValue,
    getHeader: getHeaderValue,
    appendResponseCookie,
    redirectResponse,
  } satisfies NonNullable<CreateHoloOptions['authRequest']>
}

export async function runWithNuxtRequest<TValue>(event: NuxtAuthRequestEvent, callback: () => TValue): Promise<Awaited<TValue>> {
  const accessors = createNuxtAuthRequestAccessors(event)
  await holo.getApp()
  const runner = (globalThis as RuntimeGlobals).__holoNuxtAuthRequestRunner
  return await (runner ? runner(accessors, callback) : callback())
}

export const holo = createHoloProjectAccessors(async () => {
  const config = getRuntimeConfig()
  const authRequest = createNuxtAuthRequestAccessors()
  const { createNuxtAuthorizationError } = await import('../authorization-error')
  const project = await initializeHoloAdapterProject(resolveRuntimeProjectRoot(config), {
    processEnv: process.env,
    authRequest,
    authorizationError: {
      createError: createNuxtAuthorizationError,
    },
  })
  const runtimeGlobals = globalThis as RuntimeGlobals
  runtimeGlobals.__holoNuxtAuthRequestRunner = (accessors, callback) => project.runtime.runWithAuthRequestAccessors(accessors, callback)
  return project
}, {
  cache: () => resolveProjectAppEnvironmentSync({
    cwd: resolveRuntimeProjectRoot(getRuntimeConfig()),
    processEnv: process.env,
  }) === 'production',
})

function normalizeConnection(
  connection: RuntimeConnectionConfig,
) {
  const driver = connection.driver
    ?? (connection.filename ? 'sqlite' : undefined)
  const database = connection.database
    ?? connection.filename
  const url = connection.url
    ?? (driver === 'sqlite' ? database : undefined)

  return {
    driver,
    url,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    password: connection.password,
    database,
    schema: connection.schema,
    ssl: connection.ssl,
    logging: connection.logging ?? false,
  }
}

export function useHoloDb() {
  const group: RuntimeDatabaseConfig = getHolo().loadedConfig.database
  const connections = group.connections ?? {}

  return {
    defaultConnection: group.defaultConnection ?? 'default',
    connections: Object.fromEntries(
      Object.entries(connections).map(([name, connection]) => {
        if (typeof connection === 'string') {
          return [name, { url: connection }]
        }

        return [name, normalizeConnection(connection)]
      }),
    ),
  }
}

export function useHoloEnv(): 'production' | 'development' | 'test' {
  return getHolo().loadedConfig.environment.name
}

export function useHoloDebug(): boolean {
  return getHolo().loadedConfig.app.debug
}
