import type {
  DotPath,
  HoloConfigMap,
  HoloConfigRegistry,
  ValueAtPath,
} from './types'

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
  const useConfig = ((path: string) => {
    return getValueAtPath(configMap as Record<string, unknown>, path)
  }) as UseConfigAccessor<TConfig>

  const config = ((path: string) => {
    return getValueAtPath(configMap as Record<string, unknown>, path)
  }) as ConfigAccessor<TConfig>

  return {
    useConfig,
    config,
  }
}

function getRuntimeConfigState(): { config?: RuntimeConfigMap } {
  const runtime = globalThis as typeof globalThis & {
    __holoConfigRuntime__?: { config?: RuntimeConfigMap }
  }

  runtime.__holoConfigRuntime__ ??= {}
  return runtime.__holoConfigRuntime__
}

export function configureConfigRuntime<TConfig extends RuntimeConfigMap>(configMap: TConfig): void {
  getRuntimeConfigState().config = configMap
}

export function resetConfigRuntime(): void {
  getRuntimeConfigState().config = undefined
}

function requireConfigRuntime(): RuntimeConfigMap {
  const runtimeConfigMap = getRuntimeConfigState().config
  if (!runtimeConfigMap) {
    throw new Error('Holo config runtime is not configured.')
  }

  return runtimeConfigMap
}

export function useConfig<TKey extends Extract<keyof RuntimeConfigMap, string>>(key: TKey): RuntimeConfigMap[TKey]
export function useConfig<TPath extends DotPath<RuntimeConfigMap>>(path: TPath): ValueAtPath<RuntimeConfigMap, TPath>
export function useConfig(path: string): unknown
export function useConfig(path: string): unknown {
  return createConfigAccessors(requireConfigRuntime()).useConfig(path)
}

export function config<TPath extends DotPath<RuntimeConfigMap>>(path: TPath): ValueAtPath<RuntimeConfigMap, TPath>
export function config(path: string): unknown
export function config(path: string): unknown {
  return createConfigAccessors(requireConfigRuntime()).config(path)
}
