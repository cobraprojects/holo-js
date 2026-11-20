import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_MANIFEST_BYTES = 1_048_576
const MAX_STYLESHEETS = 1_000
const ASSET_ID = /^[a-z0-9@][a-z0-9@/._:-]*$/iu
const PUBLIC_CSS_URL = /^\/(?:[a-z0-9_~-][a-z0-9._~-]*\/)*[a-z0-9_~-][a-z0-9._~-]*\.css$/iu
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype'])

function isAssetId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && ASSET_ID.test(value) && !RESERVED_IDS.has(value)
}

function invalidManifest(): Error {
  return new Error('[Holo] Invalid Holo Panels stylesheet metadata in .holo-js/generated/panels/plugins.json.')
}

export function holoPanelsStylesheetDefines(): Record<string, string> {
  let descriptor: number
  try {
    descriptor = openSync(join(process.cwd(), '.holo-js/generated/panels/plugins.json'), 'r')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {}
    throw error
  }

  let value: unknown
  try {
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) throw invalidManifest()
    value = JSON.parse(readFileSync(descriptor, 'utf8'))
  } catch (error) {
    throw new Error(invalidManifest().message, { cause: error })
  } finally {
    closeSync(descriptor)
  }

  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.get(value, 'version') !== 1) throw invalidManifest()
  if (!Object.hasOwn(value, 'stylesheets')) return {}
  const stylesheets: unknown = Reflect.get(value, 'stylesheets')
  if (!Array.isArray(stylesheets) || stylesheets.length > MAX_STYLESHEETS) throw invalidManifest()
  const urls = new Map<string, string>()
  for (const stylesheet of stylesheets as unknown[]) {
    if (!stylesheet || typeof stylesheet !== 'object' || Array.isArray(stylesheet)) throw invalidManifest()
    const name: unknown = Reflect.get(stylesheet, 'name')
    const src: unknown = Reflect.get(stylesheet, 'src')
    const components: unknown = Reflect.get(stylesheet, 'components')
    const eager: unknown = Reflect.get(stylesheet, 'eager')
    if (!isAssetId(name) || urls.has(name)
      || typeof src !== 'string' || src.length > 2_048 || !PUBLIC_CSS_URL.test(src)
      || !Array.isArray(components) || components.length > MAX_STYLESHEETS || !components.every(isAssetId)
      || (Object.hasOwn(stylesheet, 'eager') && typeof eager !== 'boolean')) throw invalidManifest()
    urls.set(name, src)
  }
  if (urls.size === 0) return {}
  return {
    'globalThis.__HOLO_PANELS_STYLESHEETS__': JSON.stringify(Object.fromEntries(urls)),
  }
}
