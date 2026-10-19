import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  activateLocalWorkspacePackages,
  restoreProjectManifest,
  stageLocalWorkspacePackages,
} from './local-workspace-packages.mjs'

const rootDir = resolve(import.meta.dirname, '..')
const optionalPackageNames = [
  'storage',
  'events',
  'queue',
  'validation',
  'forms',
  'auth',
  'authorization',
  'notifications',
  'mail',
  'broadcast',
  'realtime',
  'security',
  'cache',
]
const optionalPackages = optionalPackageNames.join(',')
const optionalPackageIsolationJourneys = [
  {
    name: 'without-optional-packages',
    packages: [],
  },
  {
    name: 'reported-selection',
    packages: ['validation', 'forms', 'auth', 'authorization', 'broadcast', 'realtime', 'security', 'cache'],
  },
]
const frameworkJourneys = [
  { framework: 'nuxt', projectName: 'journey-nuxt', port: 4387 },
  { framework: 'next', projectName: 'journey-next', port: 4388 },
  { framework: 'sveltekit', projectName: 'journey-sveltekit', port: 4389 },
]
const scaffoldFeatureDependencies = [
  '@holo-js/auth',
  '@holo-js/authorization',
  '@holo-js/broadcast',
  '@holo-js/cache',
  '@holo-js/events',
  '@holo-js/flux',
  '@holo-js/forms',
  '@holo-js/mail',
  '@holo-js/notifications',
  '@holo-js/queue',
  '@holo-js/realtime',
  '@holo-js/security',
  '@holo-js/session',
  '@holo-js/storage',
  '@holo-js/validation',
]
const scaffoldFeaturePaths = [
  'config/auth.ts',
  'config/broadcast.ts',
  'config/cache.ts',
  'config/cors.ts',
  'config/mail.ts',
  'config/notifications.ts',
  'config/queue.ts',
  'config/security.ts',
  'config/session.ts',
  'config/storage.ts',
  'server/abilities/README.md',
  'server/broadcast',
  'server/channels',
  'server/events',
  'server/jobs',
  'server/listeners',
  'server/mail',
  'server/models/User.ts',
  'server/policies/README.md',
  'server/realtime',
]
const scaffoldMigrationSuffixes = [
  '_create_users.ts',
  '_create_sessions.ts',
  '_create_auth_identities.ts',
  '_create_personal_access_tokens.ts',
  '_create_password_reset_tokens.ts',
  '_create_email_verification_tokens.ts',
  '_create_notifications.ts',
]

function resolveJourneys(argv) {
  const frameworkIndex = argv.indexOf('--framework')
  if (frameworkIndex === -1) return frameworkJourneys

  const requestedFramework = argv[frameworkIndex + 1]
  const journey = frameworkJourneys.find(candidate => candidate.framework === requestedFramework)
  if (!journey) {
    throw new Error(`Unknown framework "${requestedFramework ?? ''}".`)
  }

  return [journey]
}

function log(framework, message) {
  process.stdout.write(`[scaffold-smoke:${framework}] ${message}\n`)
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

function run(framework, command, args, options = {}) {
  log(framework, `${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
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

async function overlayLocalPackages(projectRoot, stagingRoot = process.env.HOLO_LOCAL_PACKAGES_ROOT) {
  assert.equal(typeof stagingRoot, 'string')
  const sourcesRoot = join(dirname(stagingRoot), 'local-package-sources')
  const entries = await readdir(sourcesRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const sourceRoot = join(sourcesRoot, entry.name)
    const manifestPath = join(sourceRoot, 'package.json')
    const distPath = join(sourceRoot, 'dist')
    if (!await pathExists(manifestPath) || !await pathExists(distPath)) continue

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@holo-js/')) continue

    const targetRoot = join(projectRoot, 'node_modules', ...manifest.name.split('/'))
    await rm(targetRoot, { recursive: true, force: true })
    await mkdir(targetRoot, { recursive: true })
    await cp(distPath, join(targetRoot, 'dist'), { recursive: true })
    await cp(manifestPath, join(targetRoot, 'package.json'))
  }

  await removeUndeclaredOptionalPackages(projectRoot)
}

async function resolveRequiredHoloPackages(projectRoot) {
  const rootManifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
  const requiredPackages = new Set()
  const pendingPackages = [
    ...Object.keys(rootManifest.dependencies ?? {}),
    ...Object.keys(rootManifest.devDependencies ?? {}),
  ].filter(packageName => packageName.startsWith('@holo-js/'))

  while (pendingPackages.length > 0) {
    const packageName = pendingPackages.pop()
    if (!packageName || requiredPackages.has(packageName)) continue

    requiredPackages.add(packageName)
    const manifestPath = join(projectRoot, 'node_modules', ...packageName.split('/'), 'package.json')
    if (!await pathExists(manifestPath)) continue

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const optionalPeers = new Set(
      Object.entries(manifest.peerDependenciesMeta ?? {})
        .filter(([, metadata]) => metadata?.optional === true)
        .map(([dependencyName]) => dependencyName),
    )
    const dependencies = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}).filter(dependencyName => !optionalPeers.has(dependencyName)),
    ].filter(dependencyName => dependencyName.startsWith('@holo-js/'))
    pendingPackages.push(...dependencies)
  }

  return requiredPackages
}

async function removeUndeclaredOptionalPackages(projectRoot) {
  const requiredPackages = await resolveRequiredHoloPackages(projectRoot)

  for (const packageName of scaffoldFeatureDependencies) {
    if (!requiredPackages.has(packageName)) {
      await rm(join(projectRoot, 'node_modules', ...packageName.split('/')), { recursive: true, force: true })
    }
  }
}

async function copyWorkspaceNativeDependencies(projectRoot) {
  for (const packageName of ['better-sqlite3']) {
    const directSource = join(rootDir, 'node_modules', packageName)
    const storedSource = join(rootDir, 'node_modules/.bun/node_modules', packageName)
    const source = await pathExists(directSource) ? directSource : storedSource
    const target = join(projectRoot, 'node_modules', packageName)
    assert.equal(await pathExists(source), true, `Missing workspace dependency ${packageName}.`)
    await rm(target, { recursive: true, force: true })
    await cp(source, target, { recursive: true, dereference: true })
  }
}

async function createInstallWrapper(tempRoot) {
  const binRoot = join(tempRoot, 'bin')
  const npmPath = join(binRoot, 'npm')
  await mkdir(binRoot, { recursive: true })
  await writeFile(npmPath, [
    '#!/bin/sh',
    'node "$HOLO_SMOKE_SCRIPT" --activate-local-packages "$PWD" "$HOLO_LOCAL_PACKAGES_ROOT"',
    'status=$?',
    'if [ "$status" -ne 0 ]; then exit "$status"; fi',
    '"$HOLO_REAL_NPM" install --ignore-scripts',
    'status=$?',
    'if [ "$status" -eq 0 ]; then node "$HOLO_SMOKE_SCRIPT" --overlay-local-packages "$PWD"; status=$?; fi',
    'node "$HOLO_SMOKE_SCRIPT" --restore-project-manifest "$PWD"',
    'restore_status=$?',
    'if [ "$status" -eq 0 ]; then status=$restore_status; fi',
    'exit "$status"',
    '',
  ].join('\n'), 'utf8')
  await chmod(npmPath, 0o755)
  return binRoot
}

async function assertScaffoldStructure(projectRoot, journey) {
  const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
  assert.equal(
    manifest.scripts.prepare,
    optionalPackageNames.includes('broadcast')
      ? 'holo key:generate && holo install broadcast && holo prepare'
      : 'holo key:generate && holo prepare',
  )
  assert.equal(manifest.scripts.dev, 'holo dev')
  assert.equal(manifest.scripts.build, 'holo build')
  assert.equal(manifest.scripts.start, 'holo start')
  assert.equal(manifest.dependencies['@holo-js/kernel'].startsWith('^'), true)
  for (const dependency of scaffoldFeatureDependencies) {
    assert.equal(typeof manifest.dependencies[dependency], 'string', `Missing scaffold dependency ${dependency}.`)
  }
  for (const path of scaffoldFeaturePaths) {
    assert.equal(await pathExists(join(projectRoot, path)), true, `Missing scaffold feature path ${path}.`)
  }
  assert.equal(await pathExists(join(projectRoot, '.holo-js/framework/project.json')), true)
  assert.equal(await pathExists(join(projectRoot, '.holo-js/generated/schema.generated.ts')), true)
  assert.equal(await pathExists(join(projectRoot, 'eslint.config.mjs')), true)
  assert.equal(await pathExists(join(projectRoot, 'server/holo.ts')), false)
  assert.equal(await pathExists(join(projectRoot, 'src/lib/server/holo.ts')), false)

  const migrations = await readdir(join(projectRoot, 'server/db/migrations'))
  for (const suffix of scaffoldMigrationSuffixes) {
    assert.equal(migrations.some(migration => migration.endsWith(suffix)), true, `Missing scaffold migration ${suffix}.`)
  }

  const env = await readFile(join(projectRoot, '.env'), 'utf8')
  for (const entry of ['BROADCAST_CONNECTION=holo', 'CACHE_PREFIX=', 'MAIL_MAILER=preview', 'SESSION_DRIVER=file']) {
    assert.match(env, new RegExp(`^${entry}`, 'm'))
  }

  if (journey.framework === 'next') {
    assert.equal(await pathExists(join(projectRoot, '.holo-js/generated/next/holo.ts')), true)
    assert.equal(await pathExists(join(projectRoot, 'app/api/auth/user/route.ts')), true)
  }

  if (journey.framework === 'sveltekit') {
    assert.equal(await pathExists(join(projectRoot, '.holo-js/generated/sveltekit/holo.ts')), true)
  }
}

async function assertUndeclaredOptionalPackagesAreAbsent(projectRoot) {
  const requiredPackages = await resolveRequiredHoloPackages(projectRoot)
  const undeclaredPackages = scaffoldFeatureDependencies.filter(packageName => !requiredPackages.has(packageName))

  assert.notEqual(undeclaredPackages.length, 0)
  for (const packageName of undeclaredPackages) {
    assert.equal(
      await pathExists(join(projectRoot, 'node_modules', ...packageName.split('/'))),
      false,
      `Undeclared optional package ${packageName} must be absent from the smoke project.`,
    )
  }
}

async function assertGeneratedSchema(projectRoot, tableName) {
  const schemaTypeScript = await readFile(join(projectRoot, '.holo-js/generated/schema.generated.ts'), 'utf8')
  const schemaRuntime = await readFile(join(projectRoot, '.holo-js/generated/schema.mjs'), 'utf8')
  assert.match(schemaTypeScript, new RegExp(`defineGeneratedTable\\("${tableName}"`))
  assert.match(schemaRuntime, new RegExp(`defineGeneratedTable\\("${tableName}"`))
}

const managedDriverPackages = [
  '@holo-js/cache-db',
  '@holo-js/cache-redis',
  '@holo-js/db-mysql',
  '@holo-js/db-postgres',
  '@holo-js/db-sqlite',
  '@holo-js/queue-db',
  '@holo-js/queue-redis',
  '@holo-js/storage-s3',
  'ioredis',
]

async function readProjectDependencies(projectRoot) {
  const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
  return manifest.dependencies ?? {}
}

async function waitForProjectDependencies(projectRoot, predicate, message) {
  const deadline = Date.now() + 45000
  let dependencies = {}
  while (Date.now() < deadline) {
    dependencies = await readProjectDependencies(projectRoot)
    if (await predicate(dependencies)) return dependencies
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
  }

  throw new Error(`${message}: ${JSON.stringify(dependencies)}`)
}

async function assertInstalledDriverPackages(projectRoot, packageNames) {
  const dependencies = await readProjectDependencies(projectRoot)
  for (const packageName of packageNames) {
    assert.equal(typeof dependencies[packageName], 'string', `Expected ${packageName} in project dependencies.`)
    assert.equal(
      await pathExists(join(projectRoot, 'node_modules', ...packageName.split('/'), 'package.json')),
      true,
      `Expected ${packageName} to be installed after the user command.`,
    )
  }
}

async function restoreProjectFiles(files) {
  for (const [filePath, contents] of files) {
    if (typeof contents === 'string') {
      await writeFile(filePath, contents, 'utf8')
    } else {
      await rm(filePath, { force: true })
    }
  }
}

async function runConfiguredDriverUserJourney(projectRoot, framework, cliPath, localPackageEnv) {
  const configPaths = ['database', 'queue', 'cache', 'storage', 'session', 'redis']
    .map(name => join(projectRoot, 'config', `${name}.ts`))
  const originalFiles = new Map()
  for (const configPath of configPaths) {
    originalFiles.set(configPath, await readFile(configPath, 'utf8').catch(() => undefined))
  }
  const originalDependencies = await readProjectDependencies(projectRoot)

  await writeProjectFile(projectRoot, 'config/database.ts', `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({
  defaultConnection: 'sqlite',
  connections: {
    sqlite: { driver: 'sqlite', url: './storage/database.sqlite' },
    postgres: { driver: 'postgres', url: 'postgres://localhost/holo' },
    mysql: { driver: 'mysql', url: 'mysql://localhost/holo' },
  },
})
`)
  await writeProjectFile(projectRoot, 'config/redis.ts', `
import { defineRedisConfig } from '@holo-js/kernel'

export default defineRedisConfig({
  default: 'default',
  connections: {
    default: { host: '127.0.0.1', port: 6379 },
  },
})
`)
  await writeProjectFile(projectRoot, 'config/queue.ts', `
import { defineQueueConfig } from '@holo-js/queue'

export default defineQueueConfig({
  default: 'sync',
  failed: false,
  connections: {
    sync: { driver: 'sync', queue: 'default' },
    database: { driver: 'database', connection: 'sqlite', table: 'jobs', queue: 'default' },
    redis: { driver: 'redis', connection: 'default', queue: 'default' },
  },
})
`)
  await writeProjectFile(projectRoot, 'config/cache.ts', `
import { defineCacheConfig } from '@holo-js/cache'

export default defineCacheConfig({
  default: 'file',
  drivers: {
    file: { driver: 'file', path: './storage/framework/cache/data' },
    database: { driver: 'database', connection: 'sqlite', table: 'cache', lockTable: 'cache_locks' },
    redis: { driver: 'redis', connection: 'default', prefix: 'cache:' },
  },
})
`)
  await writeProjectFile(projectRoot, 'config/storage.ts', `
import { defineStorageConfig } from '@holo-js/storage'

export default defineStorageConfig({
  defaultDisk: 'local',
  disks: {
    local: { driver: 'local', root: './storage/app' },
    archive: { driver: 's3', bucket: 'holo-smoke', region: 'us-east-1' },
  },
})
`)
  await writeProjectFile(projectRoot, 'config/session.ts', `
import { defineSessionConfig } from '@holo-js/session'

export default defineSessionConfig({
  driver: 'file',
  stores: {
    file: { driver: 'file', path: './storage/framework/sessions' },
    database: { driver: 'database', connection: 'sqlite', table: 'sessions' },
    redis: { driver: 'redis', connection: 'default', prefix: 'session:' },
  },
})
`)

  run(framework, 'npx', ['holo', 'prepare'], { cwd: projectRoot, env: localPackageEnv })
  await assertInstalledDriverPackages(projectRoot, managedDriverPackages)

  await restoreProjectFiles(originalFiles)
  run(framework, 'npx', ['holo', 'prepare'], { cwd: projectRoot, env: localPackageEnv })
  const restoredDependencies = await readProjectDependencies(projectRoot)
  for (const packageName of managedDriverPackages) {
    assert.equal(
      typeof restoredDependencies[packageName],
      typeof originalDependencies[packageName],
      `Expected holo prepare to restore the original ${packageName} dependency state.`,
    )
  }

  const databasePath = join(projectRoot, 'config/database.ts')
  const originalDatabase = originalFiles.get(databasePath)
  assert.equal(typeof originalDatabase, 'string')
  const devPort = await new Promise((resolvePromise, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Could not determine an available dev-server port.'))
        return
      }
      server.close(error => error ? reject(error) : resolvePromise(address.port))
    })
  })
  const devServer = spawn(process.execPath, [cliPath, 'dev'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...localPackageEnv,
      HOST: '127.0.0.1',
      HOSTNAME: '127.0.0.1',
      PORT: String(devPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const devJourney = { projectName: projectRoot.split('/').at(-1), port: devPort }
  try {
    await waitForRenderedApp(devJourney, devServer)
    await writeFile(databasePath, `
import { defineDatabaseConfig } from '@holo-js/db'

export default defineDatabaseConfig({
  defaultConnection: 'main',
  connections: {
    main: { driver: 'sqlite', url: './storage/database.sqlite' },
    analytics: { driver: 'postgres', url: 'postgres://localhost/holo' },
  },
})
`, 'utf8')
    await waitForProjectDependencies(
      projectRoot,
      async dependencies => typeof dependencies['@holo-js/db-postgres'] === 'string'
        && await pathExists(join(projectRoot, 'node_modules/@holo-js/db-postgres/package.json')),
      'holo dev did not detect the added Postgres connection',
    )
    await assertInstalledDriverPackages(projectRoot, ['@holo-js/db-postgres'])
    await writeFile(databasePath, originalDatabase, 'utf8')
    await waitForProjectDependencies(
      projectRoot,
      dependencies => typeof dependencies['@holo-js/db-postgres'] === 'undefined',
      'holo dev did not detect removal of the Postgres connection',
    )
    await waitForRenderedApp(devJourney, devServer)
  } finally {
    await writeFile(databasePath, originalDatabase, 'utf8')
    await stopServer(devServer)
  }
}

async function waitForRenderedApp(journey, server) {
  const url = `http://127.0.0.1:${journey.port}`
  const deadline = Date.now() + 45_000
  let lastError

  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Server exited before ${url} responded.`)
    }

    try {
      const response = await fetch(url)
      const body = await response.text()
      if (response.ok) {
        assert.match(body, new RegExp(journey.projectName))
        return
      }
      lastError = new Error(`HTTP ${response.status}: ${body}`)
    } catch (error) {
      lastError = error
    }

    await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function writeAuthSecurityRoutes(projectRoot, framework) {
  await writeProjectFile(projectRoot, 'server/support/queue-job.ts', `
import { defineJob } from '@holo-js/queue'

export function createJourneyJob(prefix: string) {
  return defineJob({
    async handle(payload: { id: string }) {
      return prefix + ':' + payload.id
    },
  })
}
`)
  for (const name of ['first', 'second']) {
    await writeProjectFile(projectRoot, `server/jobs/journey-${name}.ts`, `
import { createJourneyJob } from '../support/queue-job'

export default createJourneyJob('${name.toUpperCase()}')
`)
  }
  const jobImportRoot = framework === 'nuxt' ? '..' : framework === 'next' ? '../../../../server' : '../../../../../server'
  const jobImports = `
import First from '${jobImportRoot}/jobs/journey-first'
import Second from '${jobImportRoot}/jobs/journey-second'
`
  const jobBody = `
  const first = await First.dispatchSync({ id: '42' })
  const second = await Second.dispatchSync({ id: '42' })
  return Response.json({ first, second })
`
  if (framework === 'nuxt') {
    await writeProjectFile(projectRoot, 'server/api/security-jobs.get.ts', `
import { defineEventHandler } from 'h3'
${jobImports}
export default defineEventHandler(async () => {
${jobBody}
})
`)
  } else {
    const path = framework === 'next' ? 'app/api/security/jobs/route.ts' : 'src/routes/api/security/jobs/+server.ts'
    await writeProjectFile(projectRoot, path, `
${jobImports}
${framework === 'next' ? "import { holo } from '../../../../.holo-js/generated/next/holo'" : ''}
export async function GET() {
${framework === 'next' ? '  await holo.getApp()' : ''}
${jobBody}
}
`)
  }
  if (framework === 'sveltekit') {
    await writeProjectFile(projectRoot, 'src/hooks.server.ts', `
import { gzipSync } from 'node:zlib'
import { type Handle } from '@sveltejs/kit'

export const handle: Handle = async ({ event, resolve }) => {
  const response = await resolve(event)
  if (response.status < 400) return response
  const headers = new Headers(response.headers)
  headers.set('Content-Encoding', 'gzip')
  headers.delete('Content-Length')
  return new Response(new Uint8Array(gzipSync(new Uint8Array(await response.arrayBuffer()))), {
    status: response.status, headers,
  })
}
`)
  }
  if (framework === 'next') {
    await writeProjectFile(projectRoot, 'app/security-login/schema.ts', `
import { field, schema } from '@holo-js/validation'

export const loginSchema = schema({ email: field.string().required().email(), password: field.password().required() })
`)
    await writeProjectFile(projectRoot, 'app/security-login/actions.ts', `
'use server'

import { login } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { loginSchema } from './schema'

export async function loginAction(formData: FormData) {
  const input = await validate(formData, loginSchema, { throttle: 'login' })
  const result = await login(input)
  return { email: result.user.email }
}
`)
    await writeProjectFile(projectRoot, 'app/security-login/page.tsx', `
'use client'

import { useState } from 'react'
import { useForm } from '@holo-js/adapter-next/client'
import { loginAction } from './actions'
import { loginSchema } from './schema'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const form = useForm(loginSchema, {
    initialValues: { email: 'csrf-journey@example.com', password: 'csrf-journey-password' },
    async submitter({ formData }) {
      const result = await loginAction(formData)
      setEmail(result.email)
    },
  })
  return <form onSubmit={event => { event.preventDefault(); void form.submit() }}>
    <input name="email" value={form.values.email} onInput={event => form.fields.email.onInput(event.currentTarget.value)} />
    <input name="password" type="password" value={form.values.password} onInput={event => form.fields.password.onInput(event.currentTarget.value)} />
    <button type="submit">Sign in</button>
    <output>{email}</output>
  </form>
}
`)
  }
  const authBody = `
  const credentials = {
    email: 'csrf-journey@example.com',
    password: 'csrf-journey-password',
  }
  if (new URL(request.url).pathname.endsWith('/register')) {
    await register({ ...credentials, name: 'CSRF Journey', passwordConfirmation: credentials.password })
    return Response.json({ registered: true })
  }
  if (new URL(request.url).pathname.endsWith('/logout')) {
    await logout()
    return Response.json({ loggedOut: true })
  }
  if (new URL(request.url).pathname.endsWith('/throttle')) {
    await protect(request, { throttle: 'register' })
    return Response.json({ ok: true })
  }
  const input = await validate(request, loginSchema, { throttle: 'login' })
  const session = await login(input)
  return Response.json({ email: session.user.email })
`
  for (const action of ['register', 'login', 'logout', 'throttle']) {
    if (framework === 'nuxt') {
      await writeProjectFile(projectRoot, `server/api/security-${action}.post.ts`, `
import { login, logout, register } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { field, schema } from '@holo-js/validation'
import { protect } from '@holo-js/security'
import { defineEventHandler, toWebRequest } from 'h3'

const loginSchema = schema({ email: field.string().required().email(), password: field.password().required() })

export default defineEventHandler(async (event) => {
  const request = toWebRequest(event)
${authBody.replace("endsWith('/register')", "endsWith('-register')").replace("endsWith('/logout')", "endsWith('-logout')").replace("endsWith('/throttle')", "endsWith('-throttle')").replace('validate(request,', 'validate(event,')}
})
`)
    } else {
      const path = framework === 'next'
        ? `app/api/security/${action}/route.ts`
        : `src/routes/api/security/${action}/+server.ts`
      const signature = framework === 'next'
        ? 'request: Request'
        : '{ request }: RequestEvent'
      await writeProjectFile(projectRoot, path, `
import { login, logout, register } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { field, schema } from '@holo-js/validation'
import { protect } from '@holo-js/security'
${framework === 'sveltekit' ? "import { type RequestEvent } from '@sveltejs/kit'" : ''}

const loginSchema = schema({ email: field.string().required().email(), password: field.password().required() })

export async function POST(${signature}) {
${authBody}
}
`)
    }
  }
}

async function assertAuthSecurity(journey) {
  const origin = `http://localhost:${journey.port}`
  const route = action => journey.framework === 'nuxt'
    ? `${origin}/api/security-${action}`
    : `${origin}/api/security/${action}`
  const jobs = await fetch(route('jobs'))
  assert.equal(jobs.status, 200, await jobs.clone().text())
  assert.deepEqual(await jobs.json(), { first: 'FIRST:42', second: 'SECOND:42' })
  const page = await fetch(origin)
  const tokenCookie = page.headers.getSetCookie().find(cookie => cookie.startsWith('XSRF-TOKEN='))
  assert.ok(tokenCookie, 'Generated app must issue its CSRF cookie on GET')
  const guestSessionCookie = page.headers.getSetCookie().find(cookie => cookie.startsWith('holo_session='))
  assert.ok(guestSessionCookie, 'Generated app must start a session that stores the CSRF token on GET')
  const xsrfCookie = tokenCookie.split(';')[0]
  const cookie = `${xsrfCookie}; ${guestSessionCookie.split(';')[0]}`
  const token = decodeURIComponent(xsrfCookie.slice('XSRF-TOKEN='.length))
  const credentials = { email: 'csrf-journey@example.com', password: 'csrf-journey-password' }
  const headers = { Cookie: cookie, Origin: origin, 'X-CSRF-TOKEN': token, 'Content-Type': 'application/json' }
  const registration = await fetch(route('register'), { method: 'POST', headers })
  assert.equal(registration.status, 200, await registration.text())

  const missingCookie = await fetch(route('login'), { method: 'POST', headers: { Origin: origin } })
  assert.equal(missingCookie.status, 419, 'Login without a CSRF cookie must be rejected')
  const plantedToken = await fetch(route('login'), {
    method: 'POST',
    headers: { Cookie: xsrfCookie, Origin: origin, 'X-CSRF-TOKEN': token },
  })
  assert.equal(plantedToken.status, 419, 'A token without its session must be rejected')
  const missingToken = await fetch(route('login'), {
    method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'csrf-journey@example.com', password: 'csrf-journey-password' }),
  })
  assert.equal(missingToken.status, 419, 'Login without a submitted token must be rejected even with a signed cookie and matching Origin')
  const forgedToken = await fetch(route('login'), {
    method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'X-CSRF-TOKEN': 'forged' },
  })
  assert.equal(forgedToken.status, 419, 'Mismatched tokens must be rejected even with a same-origin header')
  const login = await fetch(route('login'), {
    method: 'POST', headers: { ...headers, Origin: 'http://localhost:3000' }, body: JSON.stringify(credentials),
  })
  assert.equal(login.status, 200, await login.clone().text())
  assert.equal((await login.json()).email, 'csrf-journey@example.com')
  assert.equal(login.headers.get('Access-Control-Allow-Origin'), 'http://localhost:3000')
  const sessionCookie = login.headers.getSetCookie().find(cookie => cookie.startsWith('holo_session='))
  assert.ok(sessionCookie, 'Login must issue its session cookie')
  const currentUser = await fetch(`${origin}/api/auth/user`, {
    headers: { Cookie: `${xsrfCookie}; ${sessionCookie.split(';')[0]}` },
  })
  assert.equal(currentUser.status, 200, await currentUser.clone().text())
  const session = await currentUser.json()
  assert.equal(session.authenticated, true)
  assert.equal(session.user.email, 'csrf-journey@example.com')
  assert.match(sessionCookie, /HttpOnly/i)
  assert.match(sessionCookie, /SameSite=Lax/i)
  const tamperedSession = await fetch(`${origin}/api/auth/user`, {
    headers: { Cookie: `${xsrfCookie}; ${sessionCookie.split(';')[0]}tampered` },
  })
  assert.equal((await tamperedSession.json()).authenticated, false, 'A tampered session cookie must not authenticate')
  const authenticatedHeaders = { ...headers, Cookie: `${xsrfCookie}; ${sessionCookie.split(';')[0]}` }
  const relogin = await fetch(route('login'), { method: 'POST', headers: authenticatedHeaders, body: JSON.stringify(credentials) })
  assert.equal(relogin.status, 200)
  const rotatedCookie = relogin.headers.getSetCookie().find(value => value.startsWith('holo_session='))
  assert.ok(rotatedCookie)
  assert.notEqual(rotatedCookie.split(';')[0], sessionCookie.split(';')[0], 'Login must rotate the existing session')
  const oldSession = await fetch(`${origin}/api/auth/user`, { headers: authenticatedHeaders })
  assert.equal((await oldSession.json()).authenticated, false, 'Rotated session must not be reusable')
  const logout = await fetch(route('logout'), {
    method: 'POST', headers: { ...headers, Cookie: `${xsrfCookie}; ${rotatedCookie.split(';')[0]}` },
  })
  assert.equal(logout.status, 200)
  const revoked = await fetch(`${origin}/api/auth/user`, {
    headers: { Cookie: `${xsrfCookie}; ${rotatedCookie.split(';')[0]}` },
  })
  assert.equal((await revoked.json()).authenticated, false, 'Logout must revoke the stored session')
  const allowedOrigin = 'http://localhost:3000'
  const crossOrigin = await fetch(`${origin}/api/auth/user`, { headers: { Origin: allowedOrigin } })
  assert.equal(crossOrigin.headers.get('Access-Control-Allow-Origin'), allowedOrigin)
  assert.equal(crossOrigin.headers.get('Access-Control-Allow-Credentials'), 'true')
  assert.match(crossOrigin.headers.get('Vary') ?? '', /Origin/i)
  const preflight = await fetch(route('login'), {
    method: 'OPTIONS',
    headers: { Origin: allowedOrigin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'X-CSRF-TOKEN' },
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), allowedOrigin)
  assert.match(preflight.headers.get('Access-Control-Allow-Headers') ?? '', /X-CSRF-TOKEN/i)
  const crossOriginRejected = await fetch(route('login'), {
    method: 'POST', headers: { Cookie: cookie, Origin: allowedOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  })
  assert.equal(crossOriginRejected.status, 419)
  assert.equal(crossOriginRejected.headers.get('Access-Control-Allow-Origin'), allowedOrigin)
  const untrusted = await fetch(`${origin}/api/auth/user`, { headers: { Origin: 'https://untrusted.example' } })
  assert.equal(untrusted.headers.get('Access-Control-Allow-Origin'), null)
  if (journey.framework === 'next') {
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true })
    try {
      const browserPage = await browser.newPage()
      await browserPage.goto(`${origin}/security-login`)
      await browserPage.locator('input[name="email"]').fill('csrf-journey@example.com')
      await browserPage.locator('input[name="password"]').fill('csrf-journey-password')
      const submission = browserPage.waitForResponse(response => response.request().method() === 'POST')
      await browserPage.getByRole('button', { name: 'Sign in' }).click()
      const response = await submission
      assert.equal(response.status(), 200, 'Valid-token server-action login must succeed')
      await browserPage.locator('output').filter({ hasText: 'csrf-journey@example.com' }).waitFor()
      const browserSession = await browserPage.request.get(`${origin}/api/auth/user`)
      assert.equal((await browserSession.json()).authenticated, true)
      await browserPage.route('**/security-login', async (route) => {
        const request = route.request()
        if (request.method() !== 'POST') return route.continue()
        const data = await new Request(request.url(), {
          method: 'POST', headers: request.headers(), body: request.postDataBuffer(),
        }).formData()
        for (const name of [...data.keys()]) {
          if (/^_\d+__token$/.test(name)) data.delete(name)
        }
        const tokenless = new Request(request.url(), { method: 'POST', body: data })
        const headers = { ...request.headers(), 'content-type': tokenless.headers.get('content-type') }
        delete headers['content-length']
        await route.continue({ headers, postData: Buffer.from(await tokenless.arrayBuffer()) })
      })
      await browserPage.locator('input[name="password"]').fill('csrf-journey-password')
      const tokenlessSubmission = browserPage.waitForResponse(response => response.request().method() === 'POST')
      await browserPage.getByRole('button', { name: 'Sign in' }).click()
      assert.equal((await tokenlessSubmission).status(), 419, 'Tokenless server actions must be rejected with a valid cookie and matching Origin')
    } finally {
      await browser.close()
    }
  }
  const nativeFormLogin = await fetch(route('login'), {
    method: 'POST', headers: { Cookie: cookie, Origin: origin },
    body: new URLSearchParams({ ...credentials, _token: token }),
  })
  assert.equal(nativeFormLogin.status, 200, await nativeFormLogin.clone().text())
  const invalidCredentials = await fetch(route('login'), {
    method: 'POST', headers, body: JSON.stringify({ ...credentials, password: 'wrong-password' }),
  })
  assert.equal(invalidCredentials.status, 422, 'Invalid credentials must return a validation response')
  assert.equal(invalidCredentials.headers.getSetCookie().some(value => value.startsWith('holo_session=')), false)
  const finalAllowed = await fetch(route('login'), { method: 'POST', headers, body: JSON.stringify(credentials) })
  assert.equal(finalAllowed.status, 200, 'Rejected CSRF requests must not consume the login limit')
  if (journey.framework !== 'next') {
    const fifthGuestAttempt = await fetch(route('login'), { method: 'POST', headers, body: JSON.stringify(credentials) })
    assert.equal(fifthGuestAttempt.status, 200, 'Five guest login attempts must be allowed')
  }
  const limited = await fetch(route('login'), { method: 'POST', headers, body: JSON.stringify(credentials) })
  assert.equal(limited.status, 429, 'The sixth login attempt must be throttled')
  const failure = await limited.json()
  assert.ok(failure.retryAfterSeconds > 0)
  assert.equal(limited.headers.getSetCookie().some(value => value.startsWith('holo_session=')), false)
  const routeAttempts = await Promise.all(Array.from({ length: 12 }, () => fetch(route('throttle'), {
    method: 'POST', headers: { ...headers, Origin: allowedOrigin },
  })))
  assert.equal(routeAttempts.filter(response => response.status === 200).length, 10)
  assert.equal(routeAttempts.filter(response => response.status === 429).length, 2, 'Plain-route throttling must return 429 under concurrent requests')
  for (const response of routeAttempts.filter(response => response.status === 429)) {
    assert.ok(Number(response.headers.get('Retry-After')) > 0, 'Throttled plain routes must expose Retry-After')
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), allowedOrigin)
    assert.ok((await response.json()).retryAfterSeconds > 0)
  }
  const managedMutation = await fetch(`${origin}/holo/realtime/mutation`, { method: 'POST' })
  assert.equal(managedMutation.status, 419, 'Managed mutation routes must also enforce CSRF')
  log(journey.framework, 'strict CSRF, native forms, CORS, login throttling, session rotation, and logout revocation passed')
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return

  server.kill('SIGTERM')
  await Promise.race([
    new Promise(resolvePromise => server.once('exit', resolvePromise)),
    new Promise(resolvePromise => setTimeout(resolvePromise, 5_000)),
  ])

  if (server.exitCode === null && server.signalCode === null) {
    server.kill('SIGKILL')
  }
}

async function runFrameworkJourney(tempRoot, journey, cliPath, realNpm, localPackageEnv) {
  const projectRoot = join(tempRoot, journey.projectName)
  const scaffold = run(journey.framework, 'node', [
    cliPath,
    'new',
    journey.projectName,
    '--framework',
    journey.framework,
    '--database',
    'sqlite',
    '--package-manager',
    'npm',
    '--package',
    optionalPackages,
  ], {
    cwd: tempRoot,
    env: localPackageEnv,
  })
  assert.match(scaffold.stdout, /Created Holo project:/)
  assert.match(scaffold.stdout, /dependencies installed/i)

  await overlayLocalPackages(projectRoot, localPackageEnv.HOLO_LOCAL_PACKAGES_ROOT)
  assert.equal(await pathExists(join(projectRoot, 'node_modules/@holo-js/adapter-shared/package.json')), true)
  run(journey.framework, realNpm, ['run', 'prepare'], { cwd: projectRoot, env: localPackageEnv })
  await assertScaffoldStructure(projectRoot, journey)
  if (journey.framework !== 'sveltekit') {
    await rm(join(projectRoot, journey.framework === 'next' ? 'proxy.ts' : 'server/middleware/csrf.ts'))
  }

  const tableName = `journey_${journey.framework.replace('sveltekit', 'svelte')}_records`
  await writeProjectFile(projectRoot, `server/db/migrations/2026_07_17_000001_create_${tableName}.ts`, `
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('${tableName}', (table) => {
      table.id()
      table.string('name')
    })
  },
  async down({ schema }) {
    await schema.dropTable('${tableName}')
  },
})
`)

  run(journey.framework, 'npx', ['holo', 'prepare'], { cwd: projectRoot, env: localPackageEnv })
  await copyWorkspaceNativeDependencies(projectRoot)
  run(journey.framework, 'npx', ['holo', 'migrate', '--force'], { cwd: projectRoot, env: localPackageEnv })
  run(journey.framework, 'npx', ['holo', 'prepare'], { cwd: projectRoot, env: localPackageEnv })
  await copyWorkspaceNativeDependencies(projectRoot)
  await overlayLocalPackages(projectRoot, localPackageEnv.HOLO_LOCAL_PACKAGES_ROOT)
  await assertGeneratedSchema(projectRoot, tableName)
  if (journey.framework === 'nuxt') {
    await runConfiguredDriverUserJourney(projectRoot, journey.framework, cliPath, localPackageEnv)
  }
  await writeAuthSecurityRoutes(projectRoot, journey.framework)
  run(journey.framework, 'npx', ['holo', 'prepare'], { cwd: projectRoot, env: localPackageEnv })
  run(journey.framework, realNpm, ['run', 'lint'], { cwd: projectRoot, env: localPackageEnv })
  assert.equal(await pathExists(join(projectRoot, 'node_modules/@holo-js/adapter-shared/package.json')), true)
  run(journey.framework, realNpm, ['run', 'typecheck'], { cwd: projectRoot, env: localPackageEnv })
  run(journey.framework, realNpm, ['run', 'build'], { cwd: projectRoot, env: localPackageEnv })

  const server = spawn(process.execPath, [cliPath, 'start'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...localPackageEnv,
      HOST: '127.0.0.1',
      HOSTNAME: '127.0.0.1',
      PORT: String(journey.port),
      ORIGIN: `http://localhost:${journey.port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let serverStdout = ''
  let serverStderr = ''
  server.stdout?.on('data', chunk => serverStdout += String(chunk))
  server.stderr?.on('data', chunk => serverStderr += String(chunk))

  try {
    await waitForRenderedApp(journey, server)
    await assertAuthSecurity(journey)
  } catch (error) {
    throw new Error([
      error instanceof Error ? error.message : String(error),
      serverStdout,
      serverStderr,
    ].filter(Boolean).join('\n'))
  } finally {
    await stopServer(server)
  }

  log(journey.framework, 'passed')
}

async function runOptionalPackageIsolationJourney(tempRoot, isolationJourney, cliPath, realNpm, localPackageEnv) {
  const framework = 'nuxt'
  const projectName = `journey-nuxt-${isolationJourney.name}`
  const projectRoot = join(tempRoot, projectName)
  const packageArgs = isolationJourney.packages.length > 0
    ? ['--package', isolationJourney.packages.join(',')]
    : []
  const scaffold = run(framework, 'node', [
    cliPath,
    'new',
    projectName,
    '--framework',
    framework,
    '--database',
    'sqlite',
    '--package-manager',
    'npm',
    ...packageArgs,
  ], {
    cwd: tempRoot,
    env: localPackageEnv,
  })

  assert.match(scaffold.stdout, /Created Holo project:/)
  assert.match(scaffold.stdout, /dependencies installed/i)
  await overlayLocalPackages(projectRoot, localPackageEnv.HOLO_LOCAL_PACKAGES_ROOT)
  await assertUndeclaredOptionalPackagesAreAbsent(projectRoot)
  run(framework, realNpm, ['run', 'prepare'], { cwd: projectRoot, env: localPackageEnv })
  await copyWorkspaceNativeDependencies(projectRoot)
  await overlayLocalPackages(projectRoot, localPackageEnv.HOLO_LOCAL_PACKAGES_ROOT)
  await assertUndeclaredOptionalPackagesAreAbsent(projectRoot)
  run(framework, realNpm, ['run', 'build'], { cwd: projectRoot, env: localPackageEnv })
  log(framework, `${isolationJourney.name} passed`)
}

const overlayIndex = process.argv.indexOf('--overlay-local-packages')

if (overlayIndex !== -1) {
  const projectRoot = process.argv[overlayIndex + 1]
  assert.equal(typeof projectRoot, 'string')
  await overlayLocalPackages(projectRoot)
  process.exit(0)
}

const activateIndex = process.argv.indexOf('--activate-local-packages')

if (activateIndex !== -1) {
  const projectRoot = process.argv[activateIndex + 1]
  const stagingRoot = process.argv[activateIndex + 2]
  assert.equal(typeof projectRoot, 'string')
  assert.equal(typeof stagingRoot, 'string')
  await activateLocalWorkspacePackages(projectRoot, stagingRoot)
  process.exit(0)
}

const restoreIndex = process.argv.indexOf('--restore-project-manifest')

if (restoreIndex !== -1) {
  const projectRoot = process.argv[restoreIndex + 1]
  assert.equal(typeof projectRoot, 'string')
  await restoreProjectManifest(projectRoot)
  process.exit(0)
}

const tempRoot = await mkdtemp(join(tmpdir(), 'holo-scaffold-user-journey-'))

try {
  log('workspace', tempRoot)
  if (!process.argv.includes('--skip-build')) {
    run('workspace', process.execPath, ['scripts/build-libraries.mjs'])
  }
  const realNpm = run('workspace', 'which', ['npm']).stdout.trim()
  const localPackagesRoot = await stageLocalWorkspacePackages(rootDir, tempRoot)
  const binRoot = await createInstallWrapper(tempRoot)
  const localPackageEnv = {
    HOLO_LOCAL_PACKAGES_ROOT: localPackagesRoot,
    HOLO_REAL_NPM: realNpm,
    HOLO_SMOKE_SCRIPT: import.meta.filename,
    PATH: `${binRoot}:${process.env.PATH ?? ''}`,
  }
  const cliPath = join(rootDir, 'packages/cli/dist/bin/holo.mjs')

  if (!process.argv.includes('--optional-isolation-only')) {
    for (const journey of resolveJourneys(process.argv.slice(2))) {
      await runFrameworkJourney(tempRoot, journey, cliPath, realNpm, localPackageEnv)
    }
  }

  if (!process.argv.includes('--skip-optional-isolation')) {
    for (const isolationJourney of optionalPackageIsolationJourneys) {
      await runOptionalPackageIsolationJourney(tempRoot, isolationJourney, cliPath, realNpm, localPackageEnv)
    }
  }

  log('success', 'all scaffold user journeys passed')
} finally {
  if (process.env.HOLO_KEEP_SMOKE_TMP !== '1') {
    await rm(tempRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })
  } else {
    log('workspace', `kept ${tempRoot}`)
  }
}
