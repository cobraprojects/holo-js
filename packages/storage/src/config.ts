export type StorageDriver = 'local' | 'public' | 's3'
export type NormalizedStorageDriver = 'local' | 'public' | 's3'
export type StorageVisibility = 'private' | 'public'

export interface BaseDiskConfig {
  driver: StorageDriver
  visibility?: StorageVisibility
  root?: string
  url?: string
  [key: string]: unknown
}

export interface LocalDiskConfig extends BaseDiskConfig {
  driver: 'local' | 'public'
  root?: string
  url?: string
}

export interface S3DiskConfig extends BaseDiskConfig {
  driver: 's3'
  bucket?: string
  region?: string
  endpoint?: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  forcePathStyleEndpoint?: boolean
}

export type DiskConfig = LocalDiskConfig | S3DiskConfig

export interface ModuleOptions {
  defaultDisk?: string
  routePrefix?: string
  disks?: Record<string, DiskConfig>
}

export interface StorageConfig {
  driver: string
  [key: string]: unknown
}

export interface RuntimeDiskConfig {
  name: string
  driver: NormalizedStorageDriver
  visibility: StorageVisibility
  root?: string
  url?: string
  bucket?: string
  region?: string
  endpoint?: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  forcePathStyleEndpoint?: boolean
}

export interface HoloStorageRuntimeConfig {
  defaultDisk: string | undefined
  diskNames: string[]
  routePrefix: string
  disks: Record<string, RuntimeDiskConfig>
}

const DEFAULT_ROUTE_PREFIX = '/storage'
const DEFAULT_DISKS: Record<string, DiskConfig> = {
  local: {
    driver: 'local',
    root: './storage/app',
  },
  public: {
    driver: 'public',
    root: './storage/app/public',
    visibility: 'public',
  },
}

const ENV_MAPPINGS: Record<string, string> = {
  DRIVER: 'driver',
  ROOT: 'root',
  URL: 'url',
  VISIBILITY: 'visibility',
  BUCKET: 'bucket',
  REGION: 'region',
  ENDPOINT: 'endpoint',
  ACCESS_KEY_ID: 'accessKeyId',
  SECRET_ACCESS_KEY: 'secretAccessKey',
  SESSION_TOKEN: 'sessionToken',
  FORCE_PATH_STYLE_ENDPOINT: 'forcePathStyleEndpoint',
}

export function normalizeRoutePrefix(value?: string): string {
  if (!value) {
    return DEFAULT_ROUTE_PREFIX
  }

  const trimmed = value.trim().replace(/\/+/g, '/')
  if (!trimmed || trimmed === '/') {
    return DEFAULT_ROUTE_PREFIX
  }

  return trimmed.startsWith('/') ? trimmed.replace(/\/$/, '') : `/${trimmed.replace(/\/$/, '')}`
}

function parseBooleanEnv(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on'
}

function resolveDefaultRoot(driver: NormalizedStorageDriver): string {
  if (driver === 'public') {
    return './storage/app/public'
  }

  return './storage/app'
}

function resolveDefaultDiskName(
  requestedDefaultDisk: string | undefined,
  diskNames: string[],
): string | undefined {
  if (requestedDefaultDisk) {
    if (diskNames.includes(requestedDefaultDisk)) {
      return requestedDefaultDisk
    }

    throw new Error(
      `[Holo Storage] default disk "${requestedDefaultDisk}" is not configured. `
      + `Available disks: ${diskNames.join(', ')}`,
    )
  }

  if (diskNames.includes('local')) {
    return 'local'
  }

  return diskNames[0]
}

export function normalizeStorageDriver(
  driver: StorageDriver,
): NormalizedStorageDriver {
  return driver === 'local'
    ? 'local'
    : driver === 'public'
      ? 'public'
      : 's3'
}

export function applyEnvOverrides(diskName: string, config: DiskConfig): DiskConfig {
  const prefix = `STORAGE_DISKS_${diskName.toUpperCase()}_`
  const merged = { ...config } as Record<string, unknown>

  for (const [envSuffix, configKey] of Object.entries(ENV_MAPPINGS)) {
    const envValue = process.env[`${prefix}${envSuffix}`]
    if (envValue === undefined) {
      continue
    }

    if (configKey === 'forcePathStyleEndpoint') {
      merged[configKey] = parseBooleanEnv(envValue)
      continue
    }

    merged[configKey] = envValue
  }

  return merged as DiskConfig
}

export function normalizeDiskConfig(diskName: string, config: DiskConfig): RuntimeDiskConfig {
  if (config.driver === 'local' && config.visibility === 'public') {
    throw new Error(
      `[Holo Storage] Local disks must remain private. Use driver "public" for publicly served local files on disk "${diskName}".`,
    )
  }

  const driver = normalizeStorageDriver(config.driver)

  if (driver === 's3') {
    const region = typeof config.region === 'string' ? config.region : 'us-east-1'
    const endpoint = typeof config.endpoint === 'string'
      ? config.endpoint
      : `https://s3.${region}.amazonaws.com`

    return {
      name: diskName,
      driver,
      visibility: config.visibility ?? 'private',
      url: typeof config.url === 'string' ? config.url : undefined,
      bucket: typeof config.bucket === 'string' ? config.bucket : undefined,
      region,
      endpoint,
      accessKeyId: typeof config.accessKeyId === 'string' ? config.accessKeyId : undefined,
      secretAccessKey: typeof config.secretAccessKey === 'string' ? config.secretAccessKey : undefined,
      sessionToken: typeof config.sessionToken === 'string' ? config.sessionToken : undefined,
      forcePathStyleEndpoint: Boolean(config.forcePathStyleEndpoint),
    }
  }

  return {
    name: diskName,
    driver,
    visibility: driver === 'public' ? 'public' : (config.visibility ?? 'private'),
    root: typeof config.root === 'string'
      ? config.root
      : resolveDefaultRoot(driver),
    url: typeof config.url === 'string'
      ? config.url
      : undefined,
  }
}

export function buildStorageConfig(config: RuntimeDiskConfig): StorageConfig {
  return buildStorageConfigWithDriver(config)
}

export function buildStorageConfigWithDriver(
  config: RuntimeDiskConfig,
  s3Driver = 's3',
): StorageConfig {
  if (config.driver === 's3') {
    return {
      driver: s3Driver,
      bucket: config.bucket,
      region: config.region,
      endpoint: config.endpoint,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken,
      forcePathStyleEndpoint: config.forcePathStyleEndpoint,
    }
  }

  return {
    driver: 'fs',
    base: config.root ?? resolveDefaultRoot(config.driver),
  }
}

function mergeDiskDefinitions(
  ...diskGroups: Array<Record<string, DiskConfig> | undefined>
): Record<string, DiskConfig> {
  const merged: Record<string, DiskConfig> = {}

  for (const diskGroup of diskGroups) {
    if (!diskGroup) {
      continue
    }

    for (const [diskName, diskConfig] of Object.entries(diskGroup)) {
      merged[diskName] = {
        ...(merged[diskName] ?? {}),
        ...diskConfig,
      } as DiskConfig
    }
  }

  return merged
}

export function normalizeModuleOptions(
  options: ModuleOptions,
  existingRuntimeConfig?: Partial<ModuleOptions>,
): HoloStorageRuntimeConfig {
  const mergedDisks = mergeDiskDefinitions(
    existingRuntimeConfig?.disks,
    options.disks,
  )

  const disksSource = Object.keys(mergedDisks).length > 0 ? mergedDisks : DEFAULT_DISKS
  const disks = Object.fromEntries(
    Object.entries(disksSource).map(([diskName, rawConfig]) => {
      const merged = applyEnvOverrides(diskName, rawConfig)
      return [diskName, normalizeDiskConfig(diskName, merged)]
    }),
  ) as Record<string, RuntimeDiskConfig>

  const diskNames = Object.keys(disks)
  const configuredDefaultDisk = process.env.STORAGE_DEFAULT_DISK
    || options.defaultDisk
    || existingRuntimeConfig?.defaultDisk
  const defaultDisk = resolveDefaultDiskName(configuredDefaultDisk, diskNames)

  return {
    defaultDisk,
    diskNames,
    routePrefix: normalizeRoutePrefix(
      process.env.STORAGE_ROUTE_PREFIX
      || options.routePrefix
      || existingRuntimeConfig?.routePrefix,
    ),
    disks,
  }
}

export function mergeModuleOptions(
  existingOptions: Partial<ModuleOptions> | undefined,
  nextOptions: ModuleOptions,
): ModuleOptions {
  const mergedDisks = mergeDiskDefinitions(
    existingOptions?.disks,
    nextOptions.disks,
  )

  return {
    defaultDisk: nextOptions.defaultDisk ?? existingOptions?.defaultDisk,
    routePrefix: nextOptions.routePrefix ?? existingOptions?.routePrefix,
    disks: Object.keys(mergedDisks).length > 0 ? mergedDisks : undefined,
  }
}

export function hasPublicLocalDisk(config: HoloStorageRuntimeConfig): boolean {
  return Object.values(config.disks).some((disk) => {
    return disk.visibility === 'public' && disk.driver !== 's3'
  })
}

export interface NitroStorageLike {
  storage: Record<string, unknown>
  [key: string]: unknown
}

export interface StorageAdapterOptionsLike {
  nitro: NitroStorageLike
}

export function applyNitroStorageConfig(
  opts: StorageAdapterOptionsLike,
  normalized: HoloStorageRuntimeConfig,
  s3Driver: string,
): void {
  const existingStorage = opts.nitro.storage || {}
  opts.nitro.storage = Object.fromEntries(
    Object.entries(existingStorage).filter(([key]) => !key.startsWith('holo:')),
  )

  for (const disk of Object.values(normalized.disks)) {
    opts.nitro.storage[`holo:${disk.name}`] = buildStorageConfigWithDriver(disk, s3Driver)
  }
}

export const storageInternals = {
  applyNitroStorageConfig,
  hasPublicLocalDisk,
  mergeModuleOptions,
  normalizeRoutePrefix,
}
