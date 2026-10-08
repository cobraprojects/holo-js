import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureEnvRuntime, env, loadConfigDirectory } from '@holo-js/config'
import { expect, it, onTestFinished } from 'vitest'
import { upsertQueuePackageDependency } from '../src/project/scaffold/dependencies'
import { loadProjectConfig } from '../src/project/config'

it('discovers queue dependencies without reading another config evaluation’s environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-queue-config-evaluation-'))
  const previous = process.env.HOLO_EVALUATION_QUEUE_DRIVER
  onTestFinished(async () => {
    configureEnvRuntime(undefined)
    if (previous === undefined) delete process.env.HOLO_EVALUATION_QUEUE_DRIVER
    else process.env.HOLO_EVALUATION_QUEUE_DRIVER = previous
    await rm(root, { recursive: true, force: true })
  })
  delete process.env.HOLO_EVALUATION_QUEUE_DRIVER
  configureEnvRuntime({ HOLO_EVALUATION_QUEUE_DRIVER: 'configured' })
  const other = join(root, 'other')
  await mkdir(join(other, 'config'), { recursive: true })
  await mkdir(join(root, 'config'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'queue-project', type: 'module' }))
  await writeFile(join(root, '.env'), 'HOLO_EVALUATION_QUEUE_DRIVER=redis\n')
  await writeFile(join(root, 'config/queue.mjs'), `
await Promise.resolve()
export default {
  default: 'jobs',
  failed: false,
  connections: { jobs: { driver: process.env.HOLO_EVALUATION_QUEUE_DRIVER } },
}
`)
  await writeFile(join(other, 'config/services.mjs'), `
await new Promise(resolve => setTimeout(resolve, 100))
export default { owner: process.env.HOLO_EVALUATION_QUEUE_DRIVER }
`)

  const loading = loadConfigDirectory(other, { processEnv: { HOLO_EVALUATION_QUEUE_DRIVER: 'database' } })
  while (process.env.HOLO_EVALUATION_QUEUE_DRIVER !== 'database') {
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  await Promise.all([loading, upsertQueuePackageDependency(root)])
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>
  }
  expect(manifest.dependencies).toHaveProperty('@holo-js/queue-redis')
  expect(manifest.dependencies).not.toHaveProperty('@holo-js/queue-db')
  expect(env('HOLO_EVALUATION_QUEUE_DRIVER')).toBe('configured')
  expect(process.env.HOLO_EVALUATION_QUEUE_DRIVER).toBeUndefined()
})

it('loads CLI project config independently of an overlapping Config evaluation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-project-config-evaluation-'))
  const previous = process.env.HOLO_EVALUATION_PROJECT_PATH
  onTestFinished(async () => {
    if (previous === undefined) delete process.env.HOLO_EVALUATION_PROJECT_PATH
    else process.env.HOLO_EVALUATION_PROJECT_PATH = previous
    await rm(root, { recursive: true, force: true })
  })
  delete process.env.HOLO_EVALUATION_PROJECT_PATH
  const other = join(root, 'other')
  await mkdir(join(other, 'config'), { recursive: true })
  await mkdir(join(root, 'config'))
  await writeFile(join(root, '.env'), 'HOLO_EVALUATION_PROJECT_PATH=second\n')
  await writeFile(join(root, 'config/app.mjs'), `
const before = process.env.HOLO_EVALUATION_PROJECT_PATH
await new Promise(resolve => setTimeout(resolve, 20))
export default { paths: { models: before, migrations: process.env.HOLO_EVALUATION_PROJECT_PATH } }
`)
  await writeFile(join(other, 'config/services.mjs'), `
await new Promise(resolve => setTimeout(resolve, 100))
export default { owner: process.env.HOLO_EVALUATION_PROJECT_PATH }
`)
  const loading = loadConfigDirectory<{ services: { owner: string } }>(other, {
    processEnv: { HOLO_EVALUATION_PROJECT_PATH: 'first' },
  })
  while (process.env.HOLO_EVALUATION_PROJECT_PATH !== 'first') {
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  const [first, second] = await Promise.all([loading, loadProjectConfig(root)])
  expect(first.custom.services.owner).toBe('first')
  expect(second.config.paths).toMatchObject({ models: 'second', migrations: 'second' })
  expect(process.env.HOLO_EVALUATION_PROJECT_PATH).toBeUndefined()
})
