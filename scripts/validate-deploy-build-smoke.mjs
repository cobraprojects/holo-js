import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const rootDir = resolve(import.meta.dirname, '..')

function log(message) {
  process.stdout.write(`[deploy-build-smoke] ${message}\n`)
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

function run(command, args, options = {}) {
  log(`${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
  })

  if (result.status !== 0) {
    throw new Error([
      `Command failed: ${command} ${args.join(' ')}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'))
  }

  return result
}

async function writeProjectFile(projectRoot, relativePath, contents) {
  const target = join(projectRoot, relativePath)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, contents, 'utf8')
}

async function overlayLocalCliDist(projectRoot) {
  const installedDist = join(projectRoot, 'node_modules/@holo-js/cli/dist')
  await rm(installedDist, { recursive: true, force: true })
  await cp(join(rootDir, 'packages/cli/dist'), installedDist, { recursive: true })
}

async function waitForHttp(url, child) {
  const deadline = Date.now() + 30_000
  let lastError

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited before responding at ${url}.`)
    }

    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }

    await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function assertGeneratedSchema(projectRoot, tableName) {
  const schemaTs = await readFile(join(projectRoot, '.holo-js/generated/schema.generated.ts'), 'utf8')
  const schemaRuntime = await readFile(join(projectRoot, '.holo-js/generated/schema.mjs'), 'utf8')
  assert.match(schemaTs, new RegExp(`defineGeneratedTable\\("${tableName}"`))
  assert.match(schemaRuntime, new RegExp(`defineGeneratedTable\\("${tableName}"`))
}

const tempRoot = await mkdtemp(join(tmpdir(), 'holo-deploy-build-smoke-'))
const projectRoot = join(tempRoot, 'deploy-next')
let server

try {
  log(`workspace: ${tempRoot}`)
  run('bun', ['run', '--filter', '@holo-js/cli', 'build'])
  run('node', [
    join(rootDir, 'packages/cli/dist/bin/holo.mjs'),
    'new',
    'deploy-next',
    '--framework',
    'next',
    '--database',
    'sqlite',
    '--package-manager',
    'npm',
  ], { cwd: tempRoot })
  await overlayLocalCliDist(projectRoot)

  await writeProjectFile(projectRoot, 'server/db/migrations/2026_01_01_000001_create_smoke_users.ts', `
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('smoke_users', (table) => {
      table.id()
      table.string('name')
    })
  },
  async down({ schema }) {
    await schema.dropTable('smoke_users')
  },
})
`)

  run('npx', ['holo', 'prepare'], { cwd: projectRoot })
  run('npx', ['holo', 'migrate'], { cwd: projectRoot })
  await assertGeneratedSchema(projectRoot, 'smoke_users')

  await rm(join(projectRoot, '.next'), { recursive: true, force: true })
  await rm(join(projectRoot, '.holo-js/framework'), { recursive: true, force: true })
  await writeProjectFile(projectRoot, '.holo-js/generated/schema.generated.ts', `
/* stale deploy placeholder */
export const tables = {} as const
`)
  await writeProjectFile(projectRoot, '.holo-js/generated/schema.mjs', `
export const tables = Object.freeze({})
`)

  run('npm', ['run', 'build'], { cwd: projectRoot })

  assert.equal(await pathExists(join(projectRoot, '.holo-js/framework/run.mjs')), true)
  assert.equal(await pathExists(join(projectRoot, '.holo-js/framework/project.json')), true)
  await assertGeneratedSchema(projectRoot, 'smoke_users')
  assert.equal(await pathExists(join(projectRoot, '.next/server')), true)

  const port = 4387
  server = spawn('npm', ['run', 'start', '--', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port), HOSTNAME: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await waitForHttp(`http://127.0.0.1:${port}`, server)
  log('passed')
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM')
  }
  if (process.env.HOLO_KEEP_SMOKE_TMP !== '1') {
    await rm(tempRoot, { recursive: true, force: true })
  } else {
    log(`kept workspace: ${tempRoot}`)
  }
}
