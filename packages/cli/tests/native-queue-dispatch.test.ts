import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { DEFAULT_HOLO_PROJECT_PATHS } from '@holo-js/kernel'
import { renderGeneratedJobImporter } from '../src/project/registry'
import { renderNextHoloHelper, renderNextRuntimeBootstrap } from '../src/project/scaffold/framework-renderers'

const execute = promisify(execFile)

it('dispatches native app job definitions after Next preloads the runtime and after reinitialization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-native-queue-'))
  try {
    await mkdir(join(root, 'node_modules'), { recursive: true })
    await symlink(resolve(import.meta.dirname, '../..'), join(root, 'node_modules/@holo-js'), 'dir')
    await mkdir(join(root, 'config'), { recursive: true })
    await mkdir(join(root, 'server/jobs'), { recursive: true })
    await mkdir(join(root, '.holo-js/generated/next'), { recursive: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
    await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from '@holo-js/config'
export default defineAppConfig({ name: 'Native Queue', key: 'base64:key', env: 'production' })
`)
    await writeFile(join(root, 'config/database.ts'), `
import { defineDatabaseConfig } from '@holo-js/db'
export default defineDatabaseConfig({ defaultConnection: 'main', connections: { main: { driver: 'sqlite', url: ':memory:' } } })
`)
    await writeFile(join(root, 'config/queue.ts'), `
import { defineQueueConfig } from '@holo-js/queue'
export default defineQueueConfig({ default: 'sync', failed: false, connections: { sync: { driver: 'sync' } } })
`)
    await writeFile(join(root, 'server/jobs/factory.ts'), `
import { defineJob } from '@holo-js/queue'
export function createJob(prefix: string) {
  return defineJob({ async handle(payload: { id: string }) { return prefix + ':' + payload.id } })
}
`)
    const jobs = ['first', 'second'].map(name => ({ sourcePath: `server/jobs/${name}.ts`, name }))
    for (const job of jobs) {
      await writeFile(join(root, job.sourcePath), `
import { createJob } from './factory'
export default createJob(${JSON.stringify(job.name.toUpperCase())})
`)
    }
    await writeFile(join(root, '.holo-js/generated/registry.json'), JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      paths: DEFAULT_HOLO_PROJECT_PATHS,
      jobs,
      models: [], migrations: [], seeders: [], commands: [], events: [], listeners: [], channels: [], broadcast: [],
    }))
    await writeFile(join(root, '.holo-js/generated/job-importer.ts'), renderGeneratedJobImporter(jobs))
    await writeFile(join(root, '.holo-js/generated/next/holo.ts'), renderNextHoloHelper())
    await writeFile(join(root, '.holo-js/generated/next/bootstrap.mjs'), renderNextRuntimeBootstrap())
    await writeFile(join(root, '.holo-js/generated/next/app.ts'), `
import { holo } from './holo'
import First from '../../../server/jobs/first'
import Second from '../../../server/jobs/second'
const [firstRuntime] = await Promise.all([holo.getApp(), holo.getApp()])
const first = await First.dispatchSync({ id: '42' })
const second = await Second.dispatchSync({ id: '42' })
await firstRuntime.runtime.shutdown()
const secondRuntime = await holo.getApp()
const restarted = await Second.dispatchSync({ id: '43' })
await secondRuntime.runtime.shutdown()
console.log(JSON.stringify({ first, second, restarted }))
`)
    const outfile = join(root, '.holo-js/generated/next/app.mjs')
    await build({
      entryPoints: [join(root, '.holo-js/generated/next/app.ts')],
      outfile,
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'esm',
      target: 'node22',
      logLevel: 'silent',
    })
    const { stdout } = await execute(process.execPath, [
      '--import', join(root, '.holo-js/generated/next/bootstrap.mjs'), outfile,
    ], { cwd: root })
    expect(JSON.parse(stdout.trim())).toEqual({ first: 'FIRST:42', second: 'SECOND:42', restarted: 'SECOND:43' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
