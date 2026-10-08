import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, onTestFinished } from 'vitest'
import {
  configureEnvRuntime,
  env,
  isEnvPlaceholder,
  loadConfigDirectory,
  resetConfigNormalizers,
  writeConfigCache,
} from '../src'

const configEntry = JSON.stringify(resolve(import.meta.dirname, '../src/index.ts'))
const roots: string[] = []
const originalOwner = process.env.HOLO_EVALUATION_OWNER
const originalCapture = process.env.HOLO_CAPTURE_ENV

afterEach(async () => {
  configureEnvRuntime(undefined)
  resetConfigNormalizers()
  if (originalOwner === undefined) delete process.env.HOLO_EVALUATION_OWNER
  else process.env.HOLO_EVALUATION_OWNER = originalOwner
  if (originalCapture === undefined) delete process.env.HOLO_CAPTURE_ENV
  else process.env.HOLO_CAPTURE_ENV = originalCapture
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function createProject(source: string, name = 'services'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-config-evaluation-'))
  roots.push(root)
  await mkdir(join(root, 'config'))
  await writeFile(join(root, 'config', `${name}.mjs`), source)
  return root
}

it('resolves each default environment without importing another project’s temporary values', async () => {
  delete process.env.HOLO_EVALUATION_OWNER
  const source = `
import { env } from ${configEntry}
await new Promise(resolve => setTimeout(resolve, 20))
export default { owner: env('HOLO_EVALUATION_OWNER'), direct: process.env.HOLO_EVALUATION_OWNER }
`
  const first = await createProject(source)
  const second = await createProject(source)
  await writeFile(join(second, '.env'), 'HOLO_EVALUATION_OWNER=second\n')
  const loading = loadConfigDirectory<{ services: { owner: string, direct: string } }>(first, {
    preferCache: false,
    processEnv: { HOLO_EVALUATION_OWNER: 'first' },
  })
  while (process.env.HOLO_EVALUATION_OWNER !== 'first') {
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  const [firstConfig, secondConfig] = await Promise.all([
    loading,
    loadConfigDirectory<{ services: { owner: string, direct: string } }>(second, { preferCache: false }),
  ])
  expect(firstConfig.custom.services).toEqual({ owner: 'first', direct: 'first' })
  expect(secondConfig.custom.services).toEqual({ owner: 'second', direct: 'second' })
  expect(process.env.HOLO_EVALUATION_OWNER).toBeUndefined()
})

it.each([false, true])('restores prior runtime values and capture state after an import failure: %s', async (capture) => {
  process.env.HOLO_EVALUATION_OWNER = 'ambient'
  delete process.env.HOLO_CAPTURE_ENV
  configureEnvRuntime({ HOLO_EVALUATION_OWNER: 'configured' }, { mode: capture ? 'capture' : 'resolve' })
  const broken = await createProject("await Promise.resolve(); throw new Error('broken config')")
  const next = await createProject(`
import { env } from ${configEntry}
export default { owner: env('HOLO_EVALUATION_OWNER') }
`)
  const failed = loadConfigDirectory(broken, {
    processEnv: { HOLO_EVALUATION_OWNER: 'broken', HOLO_CAPTURE_ENV: '1' },
  })
  const failure = expect(failed).rejects.toThrow('broken config')
  const loaded = loadConfigDirectory<{ services: { owner: string } }>(next, { processEnv: { HOLO_EVALUATION_OWNER: 'next' } })
  await failure
  expect((await loaded).custom.services).toEqual({ owner: 'next' })
  expect(process.env.HOLO_EVALUATION_OWNER).toBe('ambient')
  expect(process.env.HOLO_CAPTURE_ENV).toBeUndefined()
  const restored = env('HOLO_EVALUATION_OWNER')
  if (capture) expect(isEnvPlaceholder(restored)).toBe(true)
  else expect(restored).toBe('configured')
})

it('ends cache capture before deferred security imports and later callbacks', async () => {
  process.env.HOLO_EVALUATION_OWNER = 'ambient'
  delete process.env.HOLO_CAPTURE_ENV
  const root = await createProject(`
import { env } from ${configEntry}
await new Promise(resolve => setTimeout(resolve, 10))
export default { owner: env('HOLO_EVALUATION_OWNER'), direct: process.env.HOLO_EVALUATION_OWNER }
`)
  await writeFile(join(root, 'config/security.mjs'), `
import { env } from ${configEntry}
export default { owner: env('HOLO_EVALUATION_OWNER'), later: () => env('HOLO_EVALUATION_OWNER') }
`)
  await writeConfigCache(root, { envName: 'production', processEnv: { HOLO_EVALUATION_OWNER: 'build' } })
  const loaded = await loadConfigDirectory<{
    services: { owner: string, direct: string }
    security: { owner: string, later: () => string }
  }>(root, { envName: 'production', processEnv: { HOLO_EVALUATION_OWNER: 'live' } })
  expect(loaded.custom.services).toEqual({ owner: 'live', direct: 'build' })
  expect(loaded.custom.security.owner).toBe('live')
  expect(loaded.custom.security.later()).toBe('ambient')
  expect(process.env.HOLO_CAPTURE_ENV).toBeUndefined()
})

it('captures cache placeholders independently of overlapping live imports', async () => {
  process.env.HOLO_EVALUATION_OWNER = 'ambient'
  const source = `
import { env } from ${configEntry}
await new Promise(resolve => setTimeout(resolve, 20))
export default { owner: env('HOLO_EVALUATION_OWNER') }
`
  const cached = await createProject(source)
  const live = await createProject(source)
  const [, loaded] = await Promise.all([
    writeConfigCache(cached, { envName: 'production', processEnv: { HOLO_EVALUATION_OWNER: 'build' } }),
    loadConfigDirectory<{ services: { owner: string } }>(live, { processEnv: { HOLO_EVALUATION_OWNER: 'live' } }),
  ])
  expect(loaded.custom.services.owner).toBe('live')
  const runtime = await loadConfigDirectory<{ services: { owner: string } }>(cached, {
    envName: 'production',
    processEnv: { HOLO_EVALUATION_OWNER: 'runtime' },
  })
  expect(runtime.custom.services.owner).toBe('runtime')
  expect(process.env.HOLO_EVALUATION_OWNER).toBe('ambient')
})

it('replays cached normalizer modules before importing deferred security config', async () => {
  const runtime = globalThis as typeof globalThis & { __holoCacheReplayReady?: boolean }
  onTestFinished(() => { delete runtime.__holoCacheReplayReady })
  const root = await createProject(`
import { registerConfigNormalizer } from ${configEntry}
registerConfigNormalizer({ name: 'zeta', normalize: value => value ?? {} })
globalThis.__holoCacheReplayReady = true
export default { enabled: true }
`, 'zeta')
  await writeFile(join(root, 'config/security.mjs'), `
import { env } from ${configEntry}
if (process.env.HOLO_CAPTURE_ENV !== '1' && !globalThis.__holoCacheReplayReady) {
  throw new Error('normalizer module was not replayed first')
}
export default { ready: globalThis.__holoCacheReplayReady, later: () => env('HOLO_EVALUATION_OWNER') }
`)
  await writeConfigCache(root, { envName: 'production', processEnv: {} })
  runtime.__holoCacheReplayReady = false
  const loaded = await loadConfigDirectory<{ security: { ready: boolean, later: () => string } }>(root, {
    envName: 'production',
    processEnv: {},
  })
  expect(loaded.custom.security.ready).toBe(true)
})

it('rejects nested config loading and permits loading after the failed evaluation', async () => {
  const nested = await createProject('export default {}')
  const root = await createProject(`
import { loadConfigDirectory } from ${configEntry}
await loadConfigDirectory(${JSON.stringify(nested)}, { processEnv: {} })
export default {}
`)
  await expect(loadConfigDirectory(root, { processEnv: {} })).rejects.toThrow('active config evaluation')
  await expect(loadConfigDirectory(nested, { processEnv: {} })).resolves.toMatchObject({ custom: { services: {} } })
})
