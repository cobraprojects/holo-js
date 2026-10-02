import type {
  DotPath,
  HoloConfigMap,
  ValueAtPath,
} from './types'
import type { HoloConfigRegistry } from './index'

type RuntimeConfigMap = HoloConfigRegistry & HoloConfigMap
type UseConfigAccessor<TConfig extends RuntimeConfigMap> = {
  <TKey extends Extract<keyof TConfig, string>>(key: TKey): TConfig[TKey]
  <TPath extends DotPath<TConfig>>(path: TPath): ValueAtPath<TConfig, TPath>
  (path: string): unknown
}
type ConfigAccessor<TConfig extends RuntimeConfigMap> = {
  <TPath extends DotPath<TConfig>>(path: TPath): ValueAtPath<TConfig, TPath>
  (path: string): unknown
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getValueAtPath(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source

  for (const segment of path.split('.')) {
    if (!isObject(current) || !(segment in current)) {
      return undefined
    }

    current = current[segment]
  }

  return current
}

export function createConfigAccessors<TConfig extends RuntimeConfigMap>(configMap: TConfig): {
  useConfig: UseConfigAccessor<TConfig>
  config: ConfigAccessor<TConfig>
} {
  const accessor = ((path: string) => {
    return getValueAtPath(configMap as Record<string, unknown>, path)
  }) as UseConfigAccessor<TConfig> & ConfigAccessor<TConfig>

  return {
    useConfig: accessor,
    config: accessor,
  }
}

type RuntimeConfigState = {
  config?: RuntimeConfigMap
  previousTimezone?: { value: string | undefined }
}

function getRuntimeConfigState(): RuntimeConfigState {
  const runtime = globalThis as typeof globalThis & {
    __holoConfigRuntime__?: RuntimeConfigState
  }

  runtime.__holoConfigRuntime__ ??= {}
  return runtime.__holoConfigRuntime__
}

export function configureConfigRuntime<TConfig extends RuntimeConfigMap>(configMap: TConfig): void {
  const state = getRuntimeConfigState()
  state.previousTimezone ??= { value: process.env.TZ }
  process.env.TZ = configMap.app.timezone
  state.config = configMap
}

export function resetConfigRuntime(): void {
  const state = getRuntimeConfigState()
  if (state.previousTimezone) {
    if (state.previousTimezone.value === undefined) {
      delete process.env.TZ
    } else {
      process.env.TZ = state.previousTimezone.value
    }
    state.previousTimezone = undefined
  }
  state.config = undefined
}

function requireConfigRuntime(): RuntimeConfigMap {
  const runtimeConfigMap = getRuntimeConfigState().config
  if (!runtimeConfigMap) {
    throw new Error('Holo config runtime is not configured.')
  }

  return runtimeConfigMap
}

function getRuntimeConfigValue(path: string): unknown {
  return getValueAtPath(requireConfigRuntime() as Record<string, unknown>, path)
}

export function useConfig<TKey extends Extract<keyof RuntimeConfigMap, string>>(key: TKey): RuntimeConfigMap[TKey]
export function useConfig<TPath extends DotPath<RuntimeConfigMap>>(path: TPath): ValueAtPath<RuntimeConfigMap, TPath>
export function useConfig(path: string): unknown
export function useConfig(path: string): unknown {
  return getRuntimeConfigValue(path)
}

export function config<TPath extends DotPath<RuntimeConfigMap>>(path: TPath): ValueAtPath<RuntimeConfigMap, TPath>
export function config(path: string): unknown
export function config(path: string): unknown {
  return getRuntimeConfigValue(path)
}
