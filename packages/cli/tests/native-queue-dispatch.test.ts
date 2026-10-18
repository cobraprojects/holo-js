import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { DEFAULT_HOLO_PROJECT_PATHS } from '@holo-js/kernel'
import { renderGeneratedDefinitionImporter } from '../src/project/registry'
import { renderNextHoloHelper, renderNextRuntimeBootstrap } from '../src/project/scaffold/framework-renderers'

const execute = promisify(execFile)

const nodeTypeStrippingArgs = process.features.typescript ? [] : ['--experimental-strip-types']

it.each(['next bundle', 'native source', 'raw Node source', 'raw Node alias'] as const)('dispatches native app job definitions through %s and after reinitialization', async (startup) => {
  const root = await mkdtemp(join(tmpdir(), 'holo-native-queue-'))
  try {
    await mkdir(join(root, 'node_modules'), { recursive: true })
    await symlink(resolve(import.meta.dirname, '../..'), join(root, 'node_modules/@holo-js'), 'dir')
    await mkdir(join(root, 'config'), { recursive: true })
    await mkdir(join(root, 'server/jobs'), { recursive: true })
    await mkdir(join(root, 'server/events'), { recursive: true })
    await mkdir(join(root, 'server/listeners'), { recursive: true })
    await mkdir(join(root, '.holo-js/generated/next'), { recursive: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
    if (startup === 'raw Node alias') await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { 'domain/*': ['./server/jobs/*'] } } }))
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
    await writeFile(join(root, 'server/jobs/marker.ts'), 'export const marker = true')
    await writeFile(join(root, 'server/jobs/factory.ts'), `
${startup === 'raw Node source' ? "globalThis.factoryEvaluations = (globalThis.factoryEvaluations ?? 0) + 1\nawait import('./marker')" : ''}
import { defineJob } from '@holo-js/queue'
export function createJob(prefix: string) {
  return defineJob({ async handle(payload: { id: string }) { return prefix + ':' + payload.id } })
}
`)
    const jobs = ['first', 'second'].map(name => ({ sourcePath: `server/jobs/${name}.ts`, name }))
    for (const job of jobs) {
      await writeFile(join(root, job.sourcePath), `
import { createJob } from './factory${startup === 'raw Node source' ? '' : '.ts'}'
export default createJob(${JSON.stringify(job.name.toUpperCase())})
`)
    }
    const events = [{ sourcePath: 'server/events/requested.ts', name: 'jobs.requested' }]
    const listeners = [{ sourcePath: 'server/listeners/dispatch-jobs.ts', id: 'dispatch-jobs', eventNames: ['jobs.requested'] }]
    await writeFile(join(root, events[0]!.sourcePath), `
import { defineEvent } from '@holo-js/events'
export default defineEvent<{ id: string }>({ name: 'jobs.requested' })
`)
    await writeFile(join(root, listeners[0]!.sourcePath), `
import { defineListener } from '@holo-js/events'
import Requested from '../events/requested.ts'
import First from '${startup === 'raw Node alias' ? 'domain/first.ts' : startup === 'raw Node source' ? '@/server/jobs/first' : '../jobs/first.ts'}'
import Second from '../jobs/second${startup === 'raw Node source' ? '' : '.ts'}'
export default defineListener({
  listensTo: [Requested],
  async handle(event) {
    const first = await First.dispatchSync(event.payload)
    const second = await Second.dispatchSync(event.payload)
    globalThis.listenerResults = [first, second]
  },
})
`)
    await writeFile(join(root, '.holo-js/generated/registry.json'), JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      paths: DEFAULT_HOLO_PROJECT_PATHS,
      jobs,
      models: [], migrations: [], seeders: [], commands: [], events, listeners, channels: [], broadcast: [],
    }))
    await writeFile(join(root, '.holo-js/generated/definition-importer.ts'), renderGeneratedDefinitionImporter({ jobs, events, listeners }))
    await writeFile(join(root, '.holo-js/generated/next/holo.ts'), renderNextHoloHelper())
    await writeFile(join(root, '.holo-js/generated/next/bootstrap.mjs'), renderNextRuntimeBootstrap())
    await writeFile(join(root, '.holo-js/generated/next/app.ts'), `
import { readFile, writeFile } from 'node:fs/promises'
import { dispatchSync as dispatchRegistered } from '@holo-js/queue'
${startup === 'next bundle' ? "import { holo } from './holo'" : "import { initializeHoloAdapterProject } from '@holo-js/core'\nconst holo = { getApp: () => initializeHoloAdapterProject(process.cwd()) }"}
${startup.startsWith('raw Node') ? "import { dispatchSync } from '@holo-js/queue'\nconst First = { dispatchSync: payload => dispatchSync('first', payload) }\nconst Second = { dispatchSync: payload => dispatchSync('second', payload) }" : "import First from '../../../server/jobs/first.ts'\nimport Second from '../../../server/jobs/second.ts'"}
import Requested from '../../../server/events/requested.ts'
const [firstRuntime] = await Promise.all([holo.getApp(), holo.getApp()])
const first = await First.dispatchSync({ id: '42' })
const second = await Second.dispatchSync({ id: '42' })
const event = await Requested.dispatch({ id: '44' })
const listenerResults = globalThis.listenerResults
const factoryEvaluations = globalThis.factoryEvaluations ?? null
await firstRuntime.runtime.shutdown()
${startup === 'next bundle' ? '' : "const factoryPath = 'server/jobs/factory.ts'\nawait writeFile(factoryPath, (await readFile(factoryPath, 'utf8')).replace(\"return prefix + ':'\", \"return 'UPDATED:' + prefix + ':'\"))"}
const secondRuntime = await holo.getApp()
const restarted = ${startup === 'next bundle' ? "await Second.dispatchSync({ id: '43' })" : "await dispatchRegistered('second', { id: '43' })"}
await Requested.dispatch({ id: '45' })
const restartedListenerResults = globalThis.listenerResults
await secondRuntime.runtime.shutdown()
console.log(JSON.stringify({ first, second, restarted, listeners: event.syncListeners, listenerResults, restartedListenerResults, factoryEvaluations }))
`)
    const outfile = join(root, '.holo-js/generated/next/app.mjs')
    if (startup === 'next bundle') await build({
      entryPoints: [join(root, '.holo-js/generated/next/app.ts')],
      outfile,
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'esm',
      target: 'node22',
      logLevel: 'silent',
    })
    const { stdout } = startup === 'next bundle'
      ? await execute(process.execPath, ['--import', join(root, '.holo-js/generated/next/bootstrap.mjs'), outfile], { cwd: root })
      : await execute(process.execPath, [...nodeTypeStrippingArgs, join(root, '.holo-js/generated/next/app.ts')], { cwd: root })
    expect(JSON.parse(stdout.trim())).toEqual({ first: 'FIRST:42', second: 'SECOND:42', restarted: startup === 'next bundle' ? 'SECOND:43' : 'UPDATED:SECOND:43', listeners: 1, factoryEvaluations: startup === 'raw Node source' ? 1 : null, listenerResults: ['FIRST:44', 'SECOND:44'], restartedListenerResults: startup === 'next bundle' ? ['FIRST:45', 'SECOND:45'] : ['UPDATED:FIRST:45', 'UPDATED:SECOND:45'] })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
