import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, '../../..')
const cli = join(repoRoot, 'packages/cli/dist/bin/holo.mjs')

async function createProject() {
  const root = await mkdtemp(join(tmpdir(), 'holo-bundle-load-errors-'))
  const write = async (name: string, content: string) => {
    const path = join(root, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
  await write('package.json', JSON.stringify({ type: 'module' }))
  await mkdir(join(root, 'node_modules'), { recursive: true })
  await symlink(join(repoRoot, 'packages'), join(root, 'node_modules/@holo-js'))
  await write('config/app.ts', "import { defineAppConfig } from '@holo-js/config'; export default defineAppConfig({ name: 'Bundle Load Errors' })")
  await write('config/database.ts', "import { defineDatabaseConfig } from '@holo-js/db'; export default defineDatabaseConfig({ defaultConnection: 'main', connections: { main: { driver: 'sqlite', url: './database.sqlite' } } })")
  return { root, write }
}

async function failureOutput(root: string, args: readonly string[]): Promise<string> {
  const failure = await execute(process.execPath, [cli, ...args], { cwd: root }).then(
    () => undefined,
    (error: { stdout?: string, stderr?: string }) => `${error.stdout ?? ''}${error.stderr ?? ''}`,
  )
  expect(failure).toBeDefined()
  return failure!
}

function expectSourceLocation(output: string, packageName: string, sourcePath: string) {
  expect(output).toContain(`Cannot find package '${packageName}' imported from ${sourcePath}`)
  expect(output).not.toMatch(/\.holo-js|bundle-|\.mjs/)
}

it('names the migration source file when a migration imports a missing package', async () => {
  const { root, write } = await createProject()
  try {
    const migration = 'server/db/migrations/2026_01_01_000000_create_foo_table.ts'
    await write(migration, "import { defineMigration } from '@holo-js/db'\nimport { thing } from 'missing-package'\nexport default defineMigration({ async up() { thing() } })\n")
    expectSourceLocation(await failureOutput(root, ['migrate']), 'missing-package', migration)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

it('names the source file that imports the missing package when a migration reaches it through a helper', async () => {
  const { root, write } = await createProject()
  try {
    await write('server/support/columns.ts', "import { columns } from '@scope/missing-columns/helpers'\nexport const extraColumns = columns\n")
    await write('server/db/migrations/2026_01_01_000000_create_foo_table.ts', "import { defineMigration } from '@holo-js/db'\nimport { extraColumns } from '../../support/columns'\nexport default defineMigration({ async up() { extraColumns() } })\n")
    expectSourceLocation(await failureOutput(root, ['migrate']), '@scope/missing-columns', 'server/support/columns.ts')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

it('names the seeder source file when a seeder imports a missing package', async () => {
  const { root, write } = await createProject()
  try {
    const seeder = 'server/db/seeders/user-seeder.ts'
    await write(seeder, "import { defineSeeder } from '@holo-js/db'\nimport { faker } from 'missing-faker'\nexport default defineSeeder({ name: 'users', async run() { faker() } })\n")
    expectSourceLocation(await failureOutput(root, ['seed', '--force']), 'missing-faker', seeder)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

it('names the model source file when a model imports a missing package', async () => {
  const { root, write } = await createProject()
  try {
    const model = 'server/models/User.ts'
    await write(model, "import { defineModel } from '@holo-js/db'\nimport { slug } from 'missing-slugger'\nexport default defineModel('users', { slug })\n")
    expectSourceLocation(await failureOutput(root, ['migrate']), 'missing-slugger', model)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

it.each([
  ['import.meta.url', 'createRequire(import.meta.url)'],
  ['an aliased import.meta', 'createRequire(meta.url)'],
])('names the helper source file when a helper requires a missing package through createRequire with %s', async (_form, requireFactory) => {
  const { root, write } = await createProject()
  try {
    const migration = 'server/db/migrations/2026_01_01_000000_create_foo_table.ts'
    await write('server/support/legacy.ts', `import { createRequire } from 'node:module'\nconst meta = import.meta\nconst require = ${requireFactory}\nexport const loaded = [meta, require('missing-legacy')]\n`)
    await write(migration, "import { defineMigration } from '@holo-js/db'\nimport { loaded } from '../../support/legacy'\nexport default defineMigration({ async up() { loaded() } })\n")
    const output = await failureOutput(root, ['migrate'])
    expect(output).toMatch(/Cannot find module 'missing-legacy'\nRequire stack:\n- \S*\/server\/support\/legacy\.ts\n/)
    expect(output).not.toContain(migration)
    expect(output).not.toMatch(/\.holo-js|\.mjs/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

it('resolves import.meta.resolve specifiers in a migration as the unbundled source file would', async () => {
  const { root, write } = await createProject()
  try {
    const migrationDirectory = 'server/db/migrations'
    const resolveCalls = "[import.meta.resolve('../support/columns.ts'), import.meta.resolve('nested-columns'), import.meta.resolve('nested-columns/helpers')]"
    const resultPath = join(root, 'resolved.json')
    await write('server/node_modules/nested-columns/package.json', JSON.stringify({ name: 'nested-columns', exports: { '.': { import: './esm.mjs', require: './cjs.cjs' }, './helpers': './helpers.mjs' } }))
    await write('server/db/support/columns.ts', 'export const columns = []\n')
    await write(`${migrationDirectory}/unbundled.mjs`, `console.log(JSON.stringify(${resolveCalls}))\n`)
    await write(`${migrationDirectory}/2026_01_01_000000_create_foo_table.ts`, `import { writeFileSync } from 'node:fs'\nimport { defineMigration } from '@holo-js/db'\nwriteFileSync(${JSON.stringify(resultPath)}, JSON.stringify(${resolveCalls}))\nexport default defineMigration({ async up() {} })\n`)
    const { stdout } = await execute(process.execPath, [join(root, migrationDirectory, 'unbundled.mjs')], { cwd: root })
    await rm(join(root, migrationDirectory, 'unbundled.mjs'))
    const unbundled = JSON.parse(stdout) as string[]
    expect(unbundled[0]).toMatch(/\/server\/db\/support\/columns\.ts$/)
    expect(unbundled[1]).toMatch(/\/server\/node_modules\/nested-columns\/esm\.mjs$/)
    await execute(process.execPath, [cli, 'migrate'], { cwd: root })
    expect(JSON.parse(await readFile(resultPath, 'utf8'))).toEqual(unbundled)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
