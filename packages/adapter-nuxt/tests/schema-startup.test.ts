import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)

it('registers project-root schema before model metadata is read in a production Nuxt route', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-nuxt-schema-startup-'))
  const adapterModule = resolve(import.meta.dirname, '../src/module.ts')

  try {
    await symlink(resolve(import.meta.dirname, '../node_modules'), join(root, 'node_modules'), 'dir')
    await Promise.all(['app', 'config', 'server/models', 'server/api', '.holo-js/generated'].map(directory => mkdir(join(root, directory), { recursive: true })))
    await Promise.all([
      writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' })),
      writeFile(join(root, 'nuxt.config.ts'), `export default defineNuxtConfig({
  modules: [${JSON.stringify(adapterModule)}],
  srcDir: 'app/',
  devtools: { enabled: false },
  nitro: { preset: 'node-listener' },
})
`),
      writeFile(join(root, 'app/app.vue'), '<template><div>Schema startup</div></template>'),
      writeFile(join(root, 'config/app.ts'), `import { defineAppConfig } from '@holo-js/config'
export default defineAppConfig({
  paths: { models: 'server/models', generatedSchema: '.holo-js/generated/schema.generated.ts' },
})
`),
      writeFile(join(root, 'config/database.ts'), `import { defineDatabaseConfig } from '@holo-js/db'
export default defineDatabaseConfig({
  defaultConnection: 'main',
  connections: { main: { driver: 'sqlite', url: ':memory:' } },
})
`),
      writeFile(join(root, '.holo-js/generated/schema.generated.ts'), `import { column, defineGeneratedTable, registerGeneratedTables } from '@holo-js/db'
export const users = defineGeneratedTable('users', { id: column.id(), name: column.string() })
registerGeneratedTables({ users })
`),
      writeFile(join(root, 'server/models/User.ts'), `import { defineModel } from '@holo-js/db'
export default defineModel('users', { fillable: ['name'] })
`),
      writeFile(join(root, 'server/api/model.get.ts'), `const table = User.definition.table
const metadata = { table: table.tableName, columns: Object.keys(table.columns) }
export default defineEventHandler(() => metadata)
`),
      writeFile(join(root, 'verify.mjs'), `import { createServer } from 'node:http'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { build, loadNuxt } from 'nuxt'

const nuxt = await loadNuxt({ cwd: process.cwd(), dev: false })
try {
  await build(nuxt)
} finally {
  await nuxt.close()
}
const { listener } = await import('./.output/server/index.mjs')
const server = createServer(listener).listen(0, '127.0.0.1')
await once(server, 'listening')
try {
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/model', { signal: AbortSignal.timeout(10_000) })
  await writeFile('response.json', JSON.stringify({ status: response.status, body: await response.json() }))
} finally {
  server.closeAllConnections()
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
`),
    ])

    await execute(process.execPath, ['verify.mjs'], {
      cwd: root,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, NODE_ENV: 'production', NUXT_TELEMETRY_DISABLED: '1' },
    })
    expect(JSON.parse(await readFile(join(root, 'response.json'), 'utf8'))).toEqual({
      status: 200,
      body: { table: 'users', columns: ['id', 'name'] },
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 150_000)
