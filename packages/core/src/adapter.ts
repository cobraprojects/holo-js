import { readdir, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import {
  createHolo,
  ensureHolo,
  resetHoloRuntime,
  peekHolo,
  reconfigureOptionalHoloSubsystems,
  resetOptionalHoloSubsystems,
  type CreateHoloOptions,
  type HoloRuntime,
} from './portable/holo'
import { configureConfigRuntime, resolveEnvironmentFileOrder } from '@holo-js/config'
import type {
  DotPath,
  LoadedHoloConfig,
  HoloConfigMap,
  ValueAtPath,
} from '@holo-js/config'
import { configureDB } from '@holo-js/db'
import {
  loadGeneratedProjectRegistry,
  type GeneratedProjectRegistry,
} from './portable/registry'
import { resolveStorageKeyPath } from './storageRuntime'
import type { HoloAuthRuntimeBinding, HoloSessionRuntimeBinding } from './portable/holo'

export interface HoloAdapterProject<TCustom extends HoloConfigMap = HoloConfigMap> {
  readonly projectRoot: string
  readonly config: LoadedHoloConfig<TCustom>
  readonly registry?: GeneratedProjectRegistry
  readonly runtime: HoloRuntime<TCustom>
}

export interface HoloFrameworkOptions extends CreateHoloOptions {
  readonly projectRoot?: string
}

export interface ResolvedHoloFrameworkOptions {
  readonly projectRoot: string
  readonly runtime: CreateHoloOptions
}

export interface HoloAdapterProjectAccessors<
  TCustom extends HoloConfigMap = HoloConfigMap,
> {
  getApp(): Promise<HoloAdapterProject<TCustom>>
  getProject(): Promise<HoloAdapterProject<TCustom>>
  getSession(): Promise<HoloSessionRuntimeBinding | undefined>
  getAuth(): Promise<HoloAuthRuntimeBinding | undefined>
  useConfig<TKey extends Extract<keyof LoadedHoloConfig<TCustom>['all'], string>>(
    key: TKey,
  ): Promise<LoadedHoloConfig<TCustom>['all'][TKey]>
  useConfig<TPath extends DotPath<LoadedHoloConfig<TCustom>['all']>>(
    path: TPath,
  ): Promise<ValueAtPath<LoadedHoloConfig<TCustom>['all'], TPath>>
  config<TPath extends DotPath<LoadedHoloConfig<TCustom>['all']>>(
    path: TPath,
  ): Promise<ValueAtPath<LoadedHoloConfig<TCustom>['all'], TPath>>
}

export interface HoloFrameworkAdapterState<
  TProject extends HoloAdapterProject = HoloAdapterProject,
> {
  readonly projectRoot?: string
  readonly project?: TProject
  readonly sourceSignature?: string
}

export interface HoloAdapterCapabilities {
  readonly config: 'layered-env-and-cache'
  readonly discovery: 'generated-registries'
  readonly runtime: 'singleton-runtime'
  readonly requestContext: 'typed-project-accessors'
  readonly typing: 'inferred-file-and-dot-config'
  readonly rendering: 'framework-owned'
  readonly hosting: 'runtime-agnostic'
}

export const HOLO_MINIMUM_ADAPTER_CAPABILITIES: Readonly<HoloAdapterCapabilities> = Object.freeze({
  config: 'layered-env-and-cache',
  discovery: 'generated-registries',
  runtime: 'singleton-runtime',
  requestContext: 'typed-project-accessors',
  typing: 'inferred-file-and-dot-config',
  rendering: 'framework-owned',
  hosting: 'runtime-agnostic',
})

export function defineHoloAdapterCapabilities<TCapabilities extends HoloAdapterCapabilities>(
  capabilities: TCapabilities,
): Readonly<TCapabilities> {
  return Object.freeze({ ...capabilities })
}

function getFrameworkAdapterStateContainer<
  TProject extends HoloAdapterProject = HoloAdapterProject,
>(stateKey: string): HoloFrameworkAdapterState<TProject> {
  const runtime = globalThis as typeof globalThis & {
    __holoFrameworkAdapters__?: Record<string, HoloFrameworkAdapterState<TProject>>
  }

  runtime.__holoFrameworkAdapters__ ??= {}
  runtime.__holoFrameworkAdapters__[stateKey] ??= {}
  return runtime.__holoFrameworkAdapters__[stateKey] as HoloFrameworkAdapterState<TProject>
}

async function resolveFileStamp(filePath: string): Promise<string> {
  try {
    const metadata = await stat(filePath)
    return `${filePath}:${metadata.size}:${metadata.mtimeMs}`
  } catch {
    return `${filePath}:missing`
  }
}

const CONFIG_EXTENSION_PRIORITY = ['.ts', '.mts', '.js', '.mjs', '.cts', '.cjs'] as const
const SUPPORTED_CONFIG_EXTENSIONS = new Set<string>(CONFIG_EXTENSION_PRIORITY)

async function resolveConfigDirectoryStamp(projectRoot: string): Promise<string> {
  const configDir = resolve(projectRoot, 'config')
  const entries = await readdir(configDir, { withFileTypes: true }).catch(() => [])
  const files = entries
    .filter(entry => entry.isFile() && SUPPORTED_CONFIG_EXTENSIONS.has(extname(entry.name)))
    .map(entry => join(configDir, entry.name))
    .sort((left, right) => left.localeCompare(right))

  const stamps = await Promise.all(files.map(resolveFileStamp))
  return stamps.join('|')
}

async function resolveProjectSourceSignature(projectRoot: string, envName: string): Promise<string> {
  const registryStamp = await resolveFileStamp(resolve(projectRoot, '.holo-js/generated/registry.json'))
  const envFiles = resolveEnvironmentFileOrder(envName as never).map(relativeName => resolve(projectRoot, relativeName))
  const envStamps = await Promise.all(envFiles.map(resolveFileStamp))
  const configStamp = await resolveConfigDirectoryStamp(projectRoot)
  const registry = await loadGeneratedProjectRegistry(projectRoot)
  const jobStamps = await Promise.all((registry?.jobs ?? [])
    .map(entry => resolveFileStamp(resolve(projectRoot, entry.sourcePath))))
  const eventStamps = await Promise.all((registry?.events ?? [])
    .map(entry => resolveFileStamp(resolve(projectRoot, entry.sourcePath))))
  const listenerStamps = await Promise.all((registry?.listeners ?? [])
    .map(entry => resolveFileStamp(resolve(projectRoot, entry.sourcePath))))
  const authorizationPolicyStamps = await Promise.all((registry?.authorizationPolicies ?? [])
    .map(entry => resolveFileStamp(resolve(projectRoot, entry.sourcePath))))
  const authorizationAbilityStamps = await Promise.all((registry?.authorizationAbilities ?? [])
    .map(entry => resolveFileStamp(resolve(projectRoot, entry.sourcePath))))

  return [configStamp, registryStamp, ...envStamps, ...jobStamps, ...eventStamps, ...listenerStamps, ...authorizationPolicyStamps, ...authorizationAbilityStamps].join('||')
}

export function resolveHoloFrameworkOptions(
  options: HoloFrameworkOptions = {},
): ResolvedHoloFrameworkOptions {
  const processEnv = options.processEnv ?? process.env
  return {
    projectRoot: resolve(options.projectRoot ?? process.cwd()),
    runtime: {
      envName: options.envName,
      preferCache: options.preferCache ?? processEnv.NODE_ENV === 'production',
      processEnv,
      renderView: options.renderView,
      registerProjectQueueJobs: options.registerProjectQueueJobs,
    },
  }
}

export function createHoloProjectAccessors<
  TCustom extends HoloConfigMap = HoloConfigMap,
>(
  resolveProject: () => Promise<HoloAdapterProject<TCustom>>,
): HoloAdapterProjectAccessors<TCustom> {
  const useConfig = (async (path: string) => {
    const project = await resolveProject()
    return project.runtime.useConfig(path as never)
  }) as HoloAdapterProjectAccessors<TCustom>['useConfig']

  return {
    getApp: resolveProject,
    getProject: resolveProject,
    async getSession() {
      const project = await resolveProject()
      return project.runtime.session
    },
    async getAuth() {
      const project = await resolveProject()
      return project.runtime.auth
    },
    useConfig,
    async config<TPath extends DotPath<LoadedHoloConfig<TCustom>['all']>>(
      path: TPath,
    ): Promise<ValueAtPath<LoadedHoloConfig<TCustom>['all'], TPath>> {
      const project = await resolveProject()
      return project.runtime.config(path)
    },
  }
}

async function initializeSingletonFrameworkProject<
  TCustom extends HoloConfigMap = HoloConfigMap,
  TProject extends HoloAdapterProject<TCustom> = HoloAdapterProject<TCustom>,
>(
  stateKey: string,
  displayName: string,
  options: HoloFrameworkOptions,
  createProject: (options: ResolvedHoloFrameworkOptions) => Promise<TProject>,
): Promise<TProject> {
  const resolved = resolveHoloFrameworkOptions(options)
  const state = getFrameworkAdapterStateContainer<TProject>(stateKey)

  if (state.project) {
    if (state.projectRoot !== resolved.projectRoot) {
      throw new Error(`${displayName} Holo project already initialized for "${state.projectRoot}".`)
    }

    const currentRuntime = peekHolo<TCustom>()
    if (currentRuntime && resolve(currentRuntime.projectRoot) === resolved.projectRoot) {
      if (resolved.runtime.preferCache === false) {
        const currentSignature = await resolveProjectSourceSignature(
          resolved.projectRoot,
          currentRuntime.loadedConfig.environment.name,
        )

        if (state.sourceSignature && state.sourceSignature !== currentSignature) {
          await currentRuntime.shutdown()
          ;(state as { project?: TProject }).project = undefined
          ;(state as { projectRoot?: string }).projectRoot = undefined
          ;(state as { sourceSignature?: string }).sourceSignature = undefined
        }
      }

      if (!state.project) {
        return initializeSingletonFrameworkProject(stateKey, displayName, options, createProject)
      }

      configureConfigRuntime(currentRuntime.loadedConfig.all)
      configureDB(currentRuntime.manager)
      await reconfigureOptionalHoloSubsystems(state.project.projectRoot, currentRuntime.loadedConfig, {
        renderView: resolved.runtime.renderView,
      })

      if (state.project.runtime !== currentRuntime) {
        ;(state as { project?: TProject }).project = {
          ...state.project,
          config: currentRuntime.loadedConfig,
          registry: currentRuntime.registry,
          runtime: currentRuntime,
        } as TProject
      }

      return state.project
    }

    ;(state as { project?: TProject }).project = undefined
  }

  const project = await createProject(resolved)
  ;(state as { projectRoot?: string }).projectRoot = resolved.projectRoot
  ;(state as { project?: TProject }).project = project
  ;(state as { sourceSignature?: string }).sourceSignature = resolved.runtime.preferCache === false
    ? await resolveProjectSourceSignature(resolved.projectRoot, project.config.environment.name)
    : undefined
  return project
}

export async function resetSingletonFrameworkProject(stateKey: string): Promise<void> {
  const state = getFrameworkAdapterStateContainer(stateKey)
  ;(state as { project?: HoloAdapterProject }).project = undefined
  ;(state as { projectRoot?: string }).projectRoot = undefined
  ;(state as { sourceSignature?: string }).sourceSignature = undefined
  await resetOptionalHoloSubsystems()
  await resetHoloRuntime()
}

export interface CreateHoloFrameworkAdapterOptions {
  readonly stateKey: string
  readonly displayName: string
  readonly capabilities?: HoloAdapterCapabilities
}

export function createHoloFrameworkAdapter<
  TOptions extends HoloFrameworkOptions = HoloFrameworkOptions,
>(
  options: CreateHoloFrameworkAdapterOptions,
) {
  const capabilities = defineHoloAdapterCapabilities(
    options.capabilities ?? HOLO_MINIMUM_ADAPTER_CAPABILITIES,
  )

  async function createProject<TCustom extends HoloConfigMap = HoloConfigMap>(
    projectOptions: TOptions = {} as TOptions,
  ): Promise<HoloAdapterProject<TCustom>> {
    const resolved = resolveHoloFrameworkOptions(projectOptions)
    return createHoloAdapterProject<TCustom>(resolved.projectRoot, resolved.runtime)
  }

  async function initializeProject<TCustom extends HoloConfigMap = HoloConfigMap>(
    projectOptions: TOptions = {} as TOptions,
  ): Promise<HoloAdapterProject<TCustom>> {
    return initializeSingletonFrameworkProject<TCustom>(
      options.stateKey,
      options.displayName,
      projectOptions,
      async resolved => initializeHoloAdapterProject<TCustom>(resolved.projectRoot, resolved.runtime),
    )
  }

  function createHelpers<TCustom extends HoloConfigMap = HoloConfigMap>(
    projectOptions: TOptions = {} as TOptions,
  ): HoloAdapterProjectAccessors<TCustom> {
    return createHoloProjectAccessors<TCustom>(() => initializeProject(projectOptions))
  }

  return {
    capabilities,
    createProject,
    initializeProject,
    createHelpers,
    resetProject: () => resetSingletonFrameworkProject(options.stateKey),
    internals: {
      getState: () => getFrameworkAdapterStateContainer(options.stateKey),
      resolveOptions: (projectOptions: TOptions = {} as TOptions) =>
        resolveHoloFrameworkOptions(projectOptions),
    },
  }
}

export async function createHoloAdapterProject<TCustom extends HoloConfigMap = HoloConfigMap>(
  projectRoot: string,
  options: CreateHoloOptions = {},
): Promise<HoloAdapterProject<TCustom>> {
  const runtime = await createHolo<TCustom>(projectRoot, options)
  const project = {
    projectRoot: runtime.projectRoot,
    config: runtime.loadedConfig,
    registry: runtime.registry,
    runtime,
  }

  return project
}

export async function initializeHoloAdapterProject<TCustom extends HoloConfigMap = HoloConfigMap>(
  projectRoot: string,
  options: CreateHoloOptions = {},
): Promise<HoloAdapterProject<TCustom>> {
  const project = await createHoloAdapterProject<TCustom>(projectRoot, options)
  const runtime = await ensureHolo<TCustom>(project.projectRoot, options)
  await reconfigureOptionalHoloSubsystems(project.projectRoot, runtime.loadedConfig, {
    renderView: options.renderView,
  })

  return {
    ...project,
    runtime,
  }
}

export const adapterInternals = {
  resolveStorageKeyPath,
}
