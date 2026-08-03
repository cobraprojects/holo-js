import type { RuntimeConnectionConfig, RuntimeDatabaseConfig } from '@holo-js/db'
import {
  createHoloProjectAccessors,
  initializeHoloAdapterProject,
  type CreateHoloOptions,
} from '@holo-js/core'
import { createNuxtAuthorizationError } from '../authorization-error'

type RuntimeConfigShape = {
  holo: {
    appEnv: 'production' | 'development' | 'test'
    appDebug: boolean
    appUrl?: string
    projectRoot?: string
  }
  db?: RuntimeDatabaseConfig
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
      getHeader(name: string): number | string | readonly string[] | undefined
      setHeader(name: string, value: number | string | readonly string[]): void
    }
  }
}

type NitroContextModule = {
  readonly useEvent: () => NuxtAuthRequestEvent | undefined
}

type H3RedirectModule = {
  readonly sendRedirect: (
    event: NuxtAuthRequestEvent,
    location: string,
    code?: 301 | 302 | 303 | 307 | 308,
  ) => Promise<void>
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

function resolveRuntimeEnvName(env: RuntimeConfigShape['holo']['appEnv']): 'development' | 'production' | 'test' {
  return env
}

function resolveRuntimeProjectRoot(config: RuntimeConfigShape): string {
  return config.holo.projectRoot?.trim() || process.cwd()
}

async function loadNitroContextModule(): Promise<NitroContextModule> {
  return await import('nitropack/runtime/context') as NitroContextModule
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
    const nitroContext = await loadNitroContextModule()
    const event = requestEvent ?? nitroContext.useEvent()

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
    const nitroContext = await loadNitroContextModule()
    const event = requestEvent ?? nitroContext.useEvent()
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
    const nitroContext = await loadNitroContextModule()
    const event = requestEvent ?? nitroContext.useEvent()
    if (!event) {
      throw new TypeError('Holo Nuxt auth redirect requires an active Nitro event.')
    }

    const { sendRedirect } = await import('h3') as unknown as H3RedirectModule
    await sendRedirect(event, url, status)
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
  const project = await initializeHoloAdapterProject(resolveRuntimeProjectRoot(config), {
    envName: resolveRuntimeEnvName(config.holo.appEnv),
    preferCache: process.env.NODE_ENV === 'production',
    processEnv: process.env,
    authRequest,
    authorizationError: {
      createError: createNuxtAuthorizationError,
    },
  })
  const runtimeGlobals = globalThis as RuntimeGlobals
  runtimeGlobals.__holoNuxtAuthRequestRunner = (accessors, callback) => project.runtime.runWithAuthRequestAccessors(accessors, callback)
  return project
}, { cache: process.env.NODE_ENV === 'production' })

function resolveDefaultConnectionName(group: {
  defaultConnection?: string
  connections: Record<string, unknown>
}): string {
  if (group.defaultConnection) {
    return group.defaultConnection
  }

  const connectionNames = Object.keys(group.connections)
  if (connectionNames.includes('default')) {
    return 'default'
  }

  return connectionNames[0] ?? 'default'
}

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
  const config = getRuntimeConfig()
  const group = config.db ?? { connections: {} }
  const connections = group.connections ?? {}

  return {
    defaultConnection: resolveDefaultConnectionName({
      defaultConnection: group.defaultConnection,
      connections,
    }),
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
  const config = getRuntimeConfig()
  return resolveRuntimeEnvName(config.holo.appEnv)
}

export function useHoloDebug(): boolean {
  const config = getRuntimeConfig()
  return config.holo.appDebug
}
