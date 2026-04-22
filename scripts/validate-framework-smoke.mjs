import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { constants as fsConstants, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import BetterSqlite3 from 'better-sqlite3'
import mysql from 'mysql2/promise'
import pg from 'pg'

const rootDir = resolve(import.meta.dirname, '..')
const mysqlDatabaseName = 'holo_matrix_smoke_mysql'
const postgresDatabaseName = 'holo_matrix_smoke_postgres'
const frameworkMatrixSmokePackages = [
  '@holo-js/broadcast',
  '@holo-js/auth',
  '@holo-js/auth-social',
  '@holo-js/auth-social-google',
  '@holo-js/auth-workos',
  '@holo-js/auth-clerk',
  '@holo-js/cache',
  '@holo-js/db',
  '@holo-js/db-sqlite',
  '@holo-js/db-mysql',
  '@holo-js/db-postgres',
  '@holo-js/events',
  '@holo-js/queue',
  '@holo-js/queue-redis',
  '@holo-js/queue-db',
  '@holo-js/config',
  '@holo-js/core',
  '@holo-js/forms',
  '@holo-js/media',
  '@holo-js/session',
  '@holo-js/storage',
  '@holo-js/storage-s3',
  '@holo-js/validation',
  '@holo-js/adapter-next',
  '@holo-js/adapter-sveltekit',
  '@holo-js/adapter-nuxt',
  '@holo-js/cli',
]
const additionalRuntimeSmokePackages = [
  '@holo-js/auth-social-apple',
  '@holo-js/auth-social-discord',
  '@holo-js/auth-social-facebook',
  '@holo-js/auth-social-github',
  '@holo-js/auth-social-linkedin',
  '@holo-js/authorization',
  '@holo-js/security',
  '@holo-js/flux',
  '@holo-js/mail',
  '@holo-js/notifications',
]
const frameworkHelperSmokePackages = [
  '@holo-js/flux-react',
  '@holo-js/flux-vue',
  '@holo-js/flux-svelte',
]
const indirectSmokeCoveragePackages = [
  'create-holo-js',
  '@holo-js/cache-db',
  '@holo-js/cache-redis',
]
const smokeWorkspacePackages = [
  ...new Set([
    ...frameworkMatrixSmokePackages,
    ...additionalRuntimeSmokePackages,
    ...frameworkHelperSmokePackages,
  ]),
]

function readWorkspacePackageNames() {
  return readdirSync(resolve(rootDir, 'packages'), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map((entry) => {
      const manifestPath = join(rootDir, 'packages', entry.name, 'package.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      return manifest.name
    })
    .sort()
}

function assertSmokeCoverageDefinitions() {
  const workspacePackages = readWorkspacePackageNames()
  const coveredPackages = new Set([
    ...smokeWorkspacePackages,
    ...indirectSmokeCoveragePackages,
  ])
  const uncoveredPackages = workspacePackages.filter(packageName => !coveredPackages.has(packageName))
  if (uncoveredPackages.length > 0) {
    throw new Error(`Smoke package coverage is missing classifications for: ${uncoveredPackages.join(', ')}`)
  }
}

const frameworkApps = [
  {
    framework: 'nuxt',
    appName: 'Nuxt_test_app',
    cwd: resolve(rootDir, 'apps/Nuxt_test_app'),
    port: 3201,
    start: ['node', '.output/server/index.mjs'],
  },
  {
    framework: 'next',
    appName: 'Next_test_app',
    cwd: resolve(rootDir, 'apps/Next_test_app'),
    port: 3202,
    start: ['bunx', 'next', 'start'],
    portableStorageSmoke: {
      packageName: '@holo-js/adapter-next',
      initializeExport: 'initializeNextHoloProject',
      resetExport: 'resetNextHoloProject',
    },
  },
  {
    framework: 'sveltekit',
    appName: 'svelte_test_app',
    cwd: resolve(rootDir, 'apps/svelte_test_app'),
    port: 3203,
    start: ['node', 'build/index.js'],
    portableStorageSmoke: {
      packageName: '@holo-js/adapter-sveltekit',
      initializeExport: 'initializeSvelteKitHoloProject',
      resetExport: 'resetSvelteKitHoloProject',
    },
  },
]
const bunLockPath = join(rootDir, 'bun.lock')
const queueSmokeScenarios = Object.freeze([
  { connection: 'sync', synchronous: true },
  { connection: 'redis', synchronous: false },
  { connection: 'databaseSqlite', synchronous: false },
  { connection: 'databaseMysql', synchronous: false },
  { connection: 'databasePostgres', synchronous: false },
])

function printUsage() {
  process.stdout.write(`Usage: node scripts/validate-framework-smoke.mjs [options]

Options:
  --framework <name>        Validate a single framework fixture
  --dep <package>=<range>   Temporarily override a dependency version for the selected framework
                            Repeat this flag to override multiple packages
  --dry-run                 Print the resolved validation plan without running it
  --help                    Show this help text

Examples:
  node scripts/validate-framework-smoke.mjs
  node scripts/validate-framework-smoke.mjs --framework next
  node scripts/validate-framework-smoke.mjs --framework nuxt --dep nuxt=^5.0.0
  node scripts/validate-framework-smoke.mjs --framework sveltekit --dep @sveltejs/kit=^3.0.0 --dep vite=^6.0.0
`)
}

function parseArgs(argv) {
  const options = {
    framework: null,
    dependencyOverrides: {},
    dryRun: false,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    switch (arg) {
      case '--framework': {
        const framework = argv[index + 1]
        if (!framework) {
          throw new Error('Missing value for --framework')
        }
        options.framework = framework
        index += 1
        break
      }
      case '--dep': {
        const raw = argv[index + 1]
        if (!raw) {
          throw new Error('Missing value for --dep')
        }

        const separatorIndex = raw.indexOf('=')
        if (separatorIndex <= 0 || separatorIndex === raw.length - 1) {
          throw new Error(`Invalid dependency override "${raw}". Use --dep <package>=<range>.`)
        }

        const packageName = raw.slice(0, separatorIndex)
        const version = raw.slice(separatorIndex + 1)
        options.dependencyOverrides[packageName] = version
        index += 1
        break
      }
      case '--dry-run':
        options.dryRun = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new Error(`Unknown argument "${arg}"`)
    }
  }

  if (Object.keys(options.dependencyOverrides).length > 0 && !options.framework) {
    throw new Error('Dependency overrides require --framework so the script knows which fixture app to patch.')
  }

  return options
}

function sleep(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

function log(step, message) {
  process.stdout.write(`[smoke:${step}] ${message}\n`)
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function readOptionalText(path) {
  if (await pathExists(path)) {
    return readFile(path, 'utf8')
  }

  return null
}

async function cleanupAppStorage(app) {
  const cleanupTargets = [
    join(app.cwd, 'storage/app/matrix'),
    join(app.cwd, 'storage/app/public/matrix'),
    join(app.cwd, 'storage/app/public/media'),
  ]

  await Promise.all(cleanupTargets.map(async (target) => {
    if (await pathExists(target)) {
      await rm(target, { recursive: true, force: true })
    }
  }))
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`
}

function createQueueTableSql(tableName) {
  const table = quoteIdentifier(tableName)
  const queueAvailableIndex = quoteIdentifier(`${tableName}_queue_available_at_index`)
  const queueReservedIndex = quoteIdentifier(`${tableName}_queue_reserved_at_index`)
  const reservationIndex = quoteIdentifier(`${tableName}_reservation_id_index`)

  return [
    `DROP TABLE IF EXISTS ${table}`,
    `CREATE TABLE ${table} (
      id VARCHAR(255) PRIMARY KEY,
      job VARCHAR(255) NOT NULL,
      connection VARCHAR(255) NOT NULL,
      queue VARCHAR(255) NOT NULL,
      payload TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 1,
      available_at BIGINT NOT NULL,
      reserved_at BIGINT NULL,
      reservation_id VARCHAR(255) NULL,
      created_at BIGINT NOT NULL
    )`,
    `CREATE INDEX ${queueAvailableIndex} ON ${table} (queue, available_at)`,
    `CREATE INDEX ${queueReservedIndex} ON ${table} (queue, reserved_at)`,
    `CREATE INDEX ${reservationIndex} ON ${table} (reservation_id)`,
  ]
}

function ensureSqliteQueueTable(app, tableName) {
  const databasePath = join(app.cwd, 'storage/database.sqlite')
  const database = new BetterSqlite3(databasePath)

  try {
    for (const statement of createQueueTableSql(tableName)) {
      database.exec(statement)
    }
  } finally {
    database.close()
  }
}

async function ensureMysqlQueueTable(tableName) {
  const connection = await mysql.createConnection({
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: '',
    database: mysqlDatabaseName,
  })

  try {
    for (const statement of createQueueTableSql(tableName)) {
      await connection.query(statement.replaceAll('"', '`'))
    }
  } finally {
    await connection.end()
  }
}

async function ensurePostgresQueueTable(tableName) {
  const client = new pg.Client({
    host: '127.0.0.1',
    port: 5432,
    user: 'postgres',
    password: '',
    database: postgresDatabaseName,
  })

  try {
    await client.connect()
    for (const statement of createQueueTableSql(tableName)) {
      await client.query(statement)
    }
  } finally {
    await client.end().catch(() => undefined)
  }
}

async function prepareQueueTablesForSmoke(app) {
  ensureSqliteQueueTable(app, 'jobs_sqlite')
  await ensureMysqlQueueTable('jobs_mysql')
  await ensurePostgresQueueTable('jobs_postgres')
}

function resolveQueueSmokeFilePath(app, key) {
  return join(app.cwd, 'storage/app/matrix/queue', `${key}.json`)
}

async function readQueueSmokeRecord(app, key) {
  const filePath = resolveQueueSmokeFilePath(app, key)
  if (!await pathExists(filePath)) {
    return null
  }

  return JSON.parse(await readFile(filePath, 'utf8'))
}

function resolveEventSmokeFilePath(app, key, channel) {
  return join(app.cwd, 'storage/app/matrix/events', `${key}.${channel}.json`)
}

async function readEventSmokeRecord(app, key, channel) {
  const filePath = resolveEventSmokeFilePath(app, key, channel)
  if (!await pathExists(filePath)) {
    return null
  }

  return JSON.parse(await readFile(filePath, 'utf8'))
}

function assertQueueSmokeRecord(app, scenario, report, stored) {
  assert.ok(stored, `${app.framework} ${scenario.connection} did not persist the queue smoke record.`)
  assert.equal(stored.framework, app.framework)
  assert.equal(stored.connection, scenario.connection)
  assert.equal(stored.queue, 'smoke')
  assert.equal(stored.jobName, 'smoke.record')
  assert.equal(stored.jobId, report.dispatch.jobId)
  assert.equal(stored.payload.framework, app.framework)
  assert.equal(stored.payload.connection, scenario.connection)
  assert.equal(stored.payload.key, report.key)
  assert.equal(typeof stored.payload.issuedAt, 'number')
}

function assertEventSmokeRecord(app, channel, report, stored) {
  assert.ok(stored, `${app.framework} ${channel} event smoke did not persist a record.`)
  assert.equal(stored.framework, app.framework)
  assert.equal(stored.channel, channel)
  assert.equal(stored.eventName, 'smoke.framework-fired')
  assert.equal(stored.payload.framework, app.framework)
  assert.equal(stored.payload.key, report.key)
  assert.equal(typeof stored.payload.issuedAt, 'number')
  assert.equal(typeof stored.occurredAt, 'number')
}

async function runQueueSmokeCheck(app, baseUrl, env) {
  await prepareQueueTablesForSmoke(app)

  for (const scenario of queueSmokeScenarios) {
    if (!scenario.synchronous) {
      await runCommand(app.cwd, 'bunx', [
        'holo',
        'queue:clear',
        '--connection',
        scenario.connection,
        '--queue',
        'smoke',
      ], env)
    }

    const report = await fetchJson(`${baseUrl}/api/holo/queue?connection=${scenario.connection}`)
    assert.equal(report.ok, true)
    assert.equal(report.framework, app.framework)
    assert.equal(report.connection, scenario.connection)
    assert.equal(report.dispatch.connection, scenario.connection)
    assert.equal(report.dispatch.queue, 'smoke')
    assert.equal(report.dispatch.synchronous, scenario.synchronous)
    assert.equal(typeof report.key, 'string')
    assert.equal(typeof report.path, 'string')

    if (scenario.synchronous) {
      assert.ok(report.stored, `${app.framework} sync queue smoke dispatch did not report an inline record.`)
      assertQueueSmokeRecord(app, scenario, report, report.stored)
      const stored = await readQueueSmokeRecord(app, report.key)
      assertQueueSmokeRecord(app, scenario, report, stored)
      continue
    }

    assert.equal(report.stored, null)
    assert.equal(await readQueueSmokeRecord(app, report.key), null)

    await runCommand(app.cwd, 'bunx', [
      'holo',
      'queue:work',
      '--connection',
      scenario.connection,
      '--queue',
      'smoke',
      '--once',
    ], env)

    const stored = await readQueueSmokeRecord(app, report.key)
    assertQueueSmokeRecord(app, scenario, report, stored)
  }
}

async function runEventSmokeCheck(app, baseUrl, env) {
  await prepareQueueTablesForSmoke(app)

  await runCommand(app.cwd, 'bunx', [
    'holo',
    'queue:clear',
    '--connection',
    'databaseSqlite',
    '--queue',
    'events',
  ], env)

  const report = await fetchJson(`${baseUrl}/api/holo/events`)
  assert.equal(report.ok, true)
  assert.equal(report.framework, app.framework)
  assert.equal(report.dispatch.eventName, 'smoke.framework-fired')
  assert.equal(report.dispatch.deferred, true)
  assert.equal(report.dispatch.syncListeners, 1)
  assert.equal(report.dispatch.queuedListeners, 1)
  assert.equal(report.syncVisibleBeforeCommit, false)
  assert.equal(report.syncVisibleInsideTransactionAfterDispatch, false)
  assert.equal(report.queuedVisibleInsideTransactionAfterDispatch, false)
  assertEventSmokeRecord(app, 'sync', report, report.syncStored)
  assert.equal(report.queuedStored, null)
  assertEventSmokeRecord(app, 'sync', report, await readEventSmokeRecord(app, report.key, 'sync'))
  assert.equal(await readEventSmokeRecord(app, report.key, 'queued'), null)

  await runCommand(app.cwd, 'bunx', [
    'holo',
    'queue:work',
    '--connection',
    'databaseSqlite',
    '--queue',
    'events',
    '--once',
  ], env)

  assertEventSmokeRecord(app, 'queued', report, await readEventSmokeRecord(app, report.key, 'queued'))
}

async function runBroadcastSmokeCheck(app, baseUrl) {
  const report = await fetchJson(`${baseUrl}/api/holo/broadcast`)
  assert.equal(report.ok, true)
  assert.equal(report.framework, app.framework)
  assert.equal(report.authStatus, 200)
  assert.equal(report.authBody?.ok, true)
  assert.equal(report.authBody?.channel, 'orders.ord_smoke')
  assert.equal(report.authBody?.type, 'private')
  assert.equal(report.dispatch?.connection, 'log')
  assert.equal(report.dispatch?.driver, 'log')
  assert.equal(report.dispatch?.queued, false)
  assert.deepEqual(report.dispatch?.publishedChannels, ['private-orders.ord_smoke'])

  const authResponse = await fetch(`${baseUrl}/broadcasting/auth`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      channel_name: 'orders.ord_smoke',
      socket_id: 'smoke.1',
    }),
  })
  assert.ok([200, 401].includes(authResponse.status), `Unexpected /broadcasting/auth status: ${authResponse.status}`)
  const authPayload = await authResponse.json()
  if (authResponse.status === 200) {
    assert.equal(authPayload.ok, true)
    assert.equal(authPayload.channel, 'orders.ord_smoke')
    return
  }

  assert.equal(authPayload.ok, false)
  assert.equal(authPayload.error, 'unauthenticated')
}

async function fetchAuthorizationResponse(url) {
  const response = await fetch(url)
  const body = await response.text()
  let json = null

  if (body) {
    try {
      json = JSON.parse(body)
    } catch {
      json = null
    }
  }

  return {
    status: response.status,
    body,
    json,
  }
}

async function runAuthorizationSmokeCheck(app, baseUrl) {
  const success = await fetchAuthorizationResponse(`${baseUrl}/api/holo/authorization?actor=editor&scenario=view-published`)
  assert.equal(success.status, 200, `${app.framework} authorization success returned ${success.status}: ${success.body}`)
  assert.equal(success.json?.ok, true)
  assert.equal(success.json?.framework, app.framework)
  assert.equal(success.json?.actor, 'editor')
  assert.equal(success.json?.scenario, 'view-published')
  assert.equal(success.json?.decision?.allowed, true)
  assert.equal(success.json?.decision?.status, 200)
  assert.equal(success.json?.canViewPublished, true)
  assert.equal(success.json?.cannotDeletePublished, true)
  assert.equal(success.json?.abilityDecision?.allowed, true)
  assert.equal(success.json?.abilityDecision?.status, 200)

  const forbidden = await fetchAuthorizationResponse(`${baseUrl}/api/holo/authorization?actor=author&scenario=delete-published`)
  assert.equal(forbidden.status, 403, `${app.framework} authorization deny returned ${forbidden.status}: ${forbidden.body}`)
  assert.equal(forbidden.json?.ok, false)
  assert.equal(forbidden.json?.framework, app.framework)
  assert.equal(forbidden.json?.decision?.allowed, false)
  assert.equal(forbidden.json?.decision?.status, 403)
  assert.match(String(forbidden.json?.error ?? ''), /Only admins can delete posts/)

  const notFound = await fetchAuthorizationResponse(`${baseUrl}/api/holo/authorization?actor=guest&scenario=view-draft`)
  assert.equal(notFound.status, 404, `${app.framework} authorization concealment returned ${notFound.status}: ${notFound.body}`)
  assert.equal(notFound.json?.ok, false)
  assert.equal(notFound.json?.framework, app.framework)
  assert.equal(notFound.json?.decision?.allowed, false)
  assert.equal(notFound.json?.decision?.status, 404)
  assert.match(String(notFound.json?.error ?? ''), /Resource not found/)
}

function updateManifestDependencySections(manifest, dependencyOverrides) {
  const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
  const remaining = new Map(Object.entries(dependencyOverrides))

  for (const sectionName of sections) {
    const section = manifest[sectionName]
    if (!section || typeof section !== 'object') {
      continue
    }

    for (const [packageName, version] of remaining) {
      if (packageName in section) {
        section[packageName] = version
        remaining.delete(packageName)
      }
    }
  }

  if (!manifest.dependencies || typeof manifest.dependencies !== 'object') {
    manifest.dependencies = {}
  }

  for (const [packageName, version] of remaining) {
    manifest.dependencies[packageName] = version
  }
}

async function withDependencyOverrides(app, dependencyOverrides, callback) {
  if (Object.keys(dependencyOverrides).length === 0) {
    return callback()
  }

  const packageJsonPath = join(app.cwd, 'package.json')
  const originalPackageJson = await readFile(packageJsonPath, 'utf8')
  const originalBunLock = await readOptionalText(bunLockPath)

  log('override', `${app.framework}: applying ${JSON.stringify(dependencyOverrides)}`)

  try {
    const manifest = JSON.parse(originalPackageJson)
    updateManifestDependencySections(manifest, dependencyOverrides)
    await writeFile(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await runCommand(rootDir, 'bun', ['install'])
    return await callback()
  } finally {
    await writeFile(packageJsonPath, originalPackageJson)

    if (originalBunLock === null) {
      if (await pathExists(bunLockPath)) {
        await rm(bunLockPath, { force: true })
      }
    } else {
      await writeFile(bunLockPath, originalBunLock)
    }

    await runCommand(rootDir, 'bun', ['install'])
  }
}

async function runCommand(cwd, command, args, env = {}) {
  const label = `${command} ${args.join(' ')}`
  log('exec', `${cwd}: ${label}`)

  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', chunk => {
    stderr += chunk.toString()
  })

  const exitCode = await new Promise((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise)
    child.once('close', resolvePromise)
  })

  if (exitCode !== 0) {
    throw new Error(`Command failed (${label}) in ${cwd}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`)
  }

  return { stdout, stderr }
}

let builtWorkspacePackages = false

async function buildWorkspacePackages() {
  if (builtWorkspacePackages) {
    return
  }

  for (const packageName of smokeWorkspacePackages) {
    await runCommand(rootDir, 'bun', ['run', '--filter', packageName, 'build'])
  }

  builtWorkspacePackages = true
}

async function ensureExternalDatabases() {
  const mysqlConnection = await mysql.createConnection({
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: '',
  })
  try {
    await mysqlConnection.query(`CREATE DATABASE IF NOT EXISTS \`${mysqlDatabaseName}\``)
  } finally {
    await mysqlConnection.end()
  }

  const postgresClient = new pg.Client({
    host: '127.0.0.1',
    port: 5432,
    user: 'postgres',
    password: '',
    database: 'postgres',
  })

  try {
    await postgresClient.connect()
    const existing = await postgresClient.query('SELECT 1 FROM pg_database WHERE datname = $1', [postgresDatabaseName])
    if (existing.rowCount === 0) {
      await postgresClient.query(`CREATE DATABASE "${postgresDatabaseName}"`)
    }
  } finally {
    await postgresClient.end().catch(() => undefined)
  }
}

async function waitForServer(url, child, logs, timeoutMs = 20000) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited before becoming ready.\n${logs.stdout}\n${logs.stderr}`)
    }

    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
    } catch {
      // keep polling
    }

    await sleep(250)
  }

  throw new Error(`Timed out waiting for ${url}\n${logs.stdout}\n${logs.stderr}`)
}

async function startServer(app) {
  const [command, ...args] = app.start
  const child = spawn(command, args, {
    cwd: app.cwd,
    env: {
      ...process.env,
      PORT: String(app.port),
      HOST: '127.0.0.1',
      NITRO_HOST: '127.0.0.1',
      APP_URL: `http://127.0.0.1:${app.port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const logs = { stdout: '', stderr: '' }
  child.stdout.on('data', chunk => {
    logs.stdout += chunk.toString()
  })
  child.stderr.on('data', chunk => {
    logs.stderr += chunk.toString()
  })

  await waitForServer(`http://127.0.0.1:${app.port}/api/holo/health`, child, logs)

  return {
    child,
    logs,
    async stop() {
      if (child.exitCode !== null) {
        return
      }

      child.kill('SIGTERM')
      await Promise.race([
        new Promise(resolvePromise => child.once('close', resolvePromise)),
        sleep(5000).then(() => {
          child.kill('SIGKILL')
        }),
      ])
    },
  }
}

async function fetchJson(url) {
  const response = await fetch(url)
  const body = await response.text()
  assert.equal(response.status, 200, `${url} failed with ${response.status}: ${body}`)
  return JSON.parse(body)
}

async function fetchBinary(url, expectedContentTypePrefix) {
  const response = await fetch(url)
  const body = new Uint8Array(await response.arrayBuffer())
  assert.equal(response.status, 200, `${url} failed with ${response.status}`)
  const contentType = response.headers.get('content-type') ?? ''
  assert.match(contentType, new RegExp(`^${expectedContentTypePrefix}`), `${url} returned ${contentType}`)
  assert.ok(body.byteLength > 0, `${url} returned an empty body`)
}

async function runPortableStorageSmokeCheck(app, env) {
  if (!app.portableStorageSmoke) {
    return
  }

  const script = `
import { Storage } from '@holo-js/storage/runtime'
import { ${app.portableStorageSmoke.initializeExport}, ${app.portableStorageSmoke.resetExport} } from ${JSON.stringify(app.portableStorageSmoke.packageName)}

const requests = []
const objects = new Map()

globalThis.fetch = async (input) => {
  const request = input instanceof Request ? input : new Request(input)
  const key = decodeURIComponent(new URL(request.url).pathname.replace(/^\\/+/, ''))
  requests.push({
    method: request.method,
    url: request.url,
    authorization: request.headers.get('authorization'),
  })

  if (request.method === 'PUT') {
    objects.set(key, await request.text())
    return new Response(null, { status: 200 })
  }

  if (request.method === 'GET') {
    if (!objects.has(key)) {
      return new Response(null, { status: 404 })
    }

    return new Response(objects.get(key), { status: 200 })
  }

  if (request.method === 'HEAD') {
    return new Response(null, { status: objects.has(key) ? 200 : 404 })
  }

  if (request.method === 'DELETE') {
    objects.delete(key)
    return new Response(null, { status: 200 })
  }

  return new Response(null, { status: 500, statusText: \`Unexpected method \${request.method}\` })
}

await ${app.portableStorageSmoke.initializeExport}({
  projectRoot: process.cwd(),
  preferCache: false,
  processEnv: process.env,
})
const media = Storage.disk('media')

await media.put('smoke/framework.txt', 'portable-ok')

if (!(await media.exists('smoke/framework.txt'))) {
  throw new Error('Portable storage smoke check did not persist the object.')
}

if (await media.get('smoke/framework.txt') !== 'portable-ok') {
  throw new Error('Portable storage smoke check returned an unexpected payload.')
}

await media.delete('smoke/framework.txt')

if (await media.exists('smoke/framework.txt')) {
  throw new Error('Portable storage smoke check failed to delete the object.')
}

if (!requests[0]?.authorization) {
  throw new Error('Portable storage smoke check did not sign the S3 request.')
}

if (!requests[0]?.url.includes('https://media-bucket.s3.us-east-1.amazonaws.com/')) {
  throw new Error(\`Portable storage smoke check used an unexpected endpoint: \${requests[0]?.url}\`)
}

await ${app.portableStorageSmoke.resetExport}()
console.log(JSON.stringify({ framework: ${JSON.stringify(app.framework)}, requests: requests.length }))
`

  await runCommand(app.cwd, 'node', ['--input-type=module', '--eval', script], env)
}

function createAdditionalPackageSmokeScript(app) {
  return `
import assert from 'node:assert/strict'
import {
  configureMailRuntime,
  defineMail,
  previewMail,
  renderMailPreview,
  sendMail,
} from '@holo-js/mail'
import {
  configureNotificationsRuntime,
  deleteNotifications,
  listNotifications,
  markNotificationsAsRead,
  markNotificationsAsUnread,
  notify,
  unreadNotifications,
} from '@holo-js/notifications'
import {
  SecurityCsrfError,
  SecurityRateLimitError,
  clearRateLimit,
  configureSecurityRuntime,
  createMemoryRateLimitStore,
  csrf,
  defaultRateLimitKey,
  defineSecurityConfig,
  ip,
  limit,
  protect,
  rateLimit,
} from '@holo-js/security'
import { createFluxClient, fluxInternals } from '@holo-js/flux'
import appleSocialProvider from '@holo-js/auth-social-apple'
import discordSocialProvider from '@holo-js/auth-social-discord'
import facebookSocialProvider from '@holo-js/auth-social-facebook'
import githubSocialProvider from '@holo-js/auth-social-github'
import linkedinSocialProvider from '@holo-js/auth-social-linkedin'

const framework = ${JSON.stringify(app.framework)}
const originalFetch = globalThis.fetch

function createJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return \`\${header}.\${body}.\`
}

function installMockFetch(responses) {
  let index = 0
  globalThis.fetch = async () => {
    const response = responses[index]
    index += 1
    if (!response) {
      throw new Error(\`Unexpected fetch call \${index} during \${framework} package smoke.\`)
    }
    return response
  }
}

try {
  process.env.APP_ENV = 'development'

  configureMailRuntime({
    renderView: async ({ view, props }) => {
      if (view === 'emails/layout') {
        return \`<article data-wrapper="true">\${String(props?.html ?? '')}</article>\`
      }

      return \`<section data-view="\${view}">\${String(props?.subject ?? '')}</section>\`
    },
    send: async () => ({
      messageId: \`\${framework}-mail-1\`,
      mailer: 'smoke',
      driver: 'smoke',
      queued: false,
    }),
    config: {
      default: 'smoke',
      from: {
        email: 'smoke@example.com',
        name: 'Smoke',
      },
      mailers: {
        smoke: {
          driver: 'preview',
          queue: {},
        },
      },
      queue: {},
      preview: {
        allowedEnvironments: ['development', 'test', 'production'],
      },
    },
  })

  const smokeMail = defineMail({
    to: 'ava@example.com',
    subject: \`\${framework} smoke mail\`,
    markdown: '# Smoke',
    markdownWrapper: 'emails/layout',
  })
  const preview = await previewMail(smokeMail)
  assert.equal(preview.subject, \`\${framework} smoke mail\`)
  assert.match(preview.html ?? '', /<article data-wrapper="true">/)
  const previewResponse = await renderMailPreview(smokeMail)
  assert.equal(previewResponse.status, 200)
  assert.match(await previewResponse.text(), /<h1>Smoke<\\/h1>/)
  const sentMail = await sendMail(smokeMail)
  assert.equal(sentMail.messageId, \`\${framework}-mail-1\`)
  assert.equal(sentMail.queued, false)

  const mailDeliveries = []
  const broadcastDeliveries = []
  const notificationRecords = []
  let notificationCounter = 0

  configureNotificationsRuntime({
    mailer: {
      async send(message, context) {
        mailDeliveries.push({ message, context })
      },
    },
    broadcaster: {
      async send(message, context) {
        broadcastDeliveries.push({ message, context })
      },
    },
    store: {
      async create(record) {
        notificationCounter += 1
        notificationRecords.push({
          ...record,
          id: \`notif-\${notificationCounter}\`,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        })
      },
      async list(target) {
        return notificationRecords.filter(record => (
          String(record.notifiableId) === String(target.id)
          && record.notifiableType === target.type
        ))
      },
      async unread(target) {
        return notificationRecords.filter(record => (
          String(record.notifiableId) === String(target.id)
          && record.notifiableType === target.type
          && record.readAt === null
        ))
      },
      async markAsRead(ids) {
        let updated = 0
        for (const record of notificationRecords) {
          if (ids.includes(record.id) && record.readAt === null) {
            record.readAt = new Date('2026-01-02T00:00:00.000Z')
            updated += 1
          }
        }

        return updated
      },
      async markAsUnread(ids) {
        let updated = 0
        for (const record of notificationRecords) {
          if (ids.includes(record.id) && record.readAt !== null) {
            record.readAt = null
            updated += 1
          }
        }

        return updated
      },
      async delete(ids) {
        let removed = 0
        for (let index = notificationRecords.length - 1; index >= 0; index -= 1) {
          if (ids.includes(notificationRecords[index].id)) {
            notificationRecords.splice(index, 1)
            removed += 1
          }
        }

        return removed
      },
    },
  })

  const invoicePaid = {
    type: 'invoice-paid',
    via() {
      return ['email', 'database', 'broadcast']
    },
    build: {
      email(user) {
        return {
          subject: \`Invoice paid for \${user.email}\`,
        }
      },
      database() {
        return {
          data: {
            invoiceId: \`inv-\${framework}\`,
          },
        }
      },
      broadcast() {
        return {
          event: 'notifications.invoice-paid',
          data: {
            invoiceId: \`inv-\${framework}\`,
          },
        }
      },
    },
  }

  const notificationResult = await notify({
    id: 'user-1',
    type: 'users',
    email: 'ava@example.com',
    name: 'Ava',
    routeNotificationForBroadcast() {
      return ['private-users.user-1']
    },
  }, invoicePaid)

  assert.equal(notificationResult.totalTargets, 1)
  assert.deepEqual(notificationResult.channels.map(entry => ({
    channel: entry.channel,
    success: entry.success,
    queued: entry.queued,
  })), [
    { channel: 'email', success: true, queued: false },
    { channel: 'database', success: true, queued: false },
    { channel: 'broadcast', success: true, queued: false },
  ])
  assert.equal(mailDeliveries.length, 1)
  assert.equal(broadcastDeliveries.length, 1)

  const listedNotifications = await listNotifications({ id: 'user-1', type: 'users' })
  assert.equal(listedNotifications.length, 1)
  assert.equal((await unreadNotifications({ id: 'user-1', type: 'users' })).length, 1)
  assert.equal(await markNotificationsAsRead([listedNotifications[0].id]), 1)
  assert.equal((await unreadNotifications({ id: 'user-1', type: 'users' })).length, 0)
  assert.equal(await markNotificationsAsUnread([listedNotifications[0].id]), 1)
  assert.equal((await unreadNotifications({ id: 'user-1', type: 'users' })).length, 1)
  assert.equal(await deleteNotifications([listedNotifications[0].id]), 1)
  assert.equal((await listNotifications({ id: 'user-1', type: 'users' })).length, 0)

  process.env.HOLO_SECURITY_TRUST_PROXY = 'true'
  configureSecurityRuntime({
    config: defineSecurityConfig({
      csrf: {
        enabled: true,
      },
      rateLimit: {
        driver: 'memory',
        limiters: {
          login: limit.perMinute(1).by(({ request, values }) => {
            return \`\${ip(request, true)}:\${String(values?.email ?? 'guest')}\`
          }),
          api: limit.perMinute(1).define(),
        },
      },
    }),
    rateLimitStore: createMemoryRateLimitStore(),
    csrfSigningKey: 'smoke-security-key',
  })

  const csrfSeedRequest = new Request('https://app.test/login')
  const csrfToken = await csrf.token(csrfSeedRequest)
  const csrfField = await csrf.field(csrfSeedRequest)
  const csrfCookie = await csrf.cookie(csrfSeedRequest, csrfToken)
  assert.equal(csrfField.value, csrfToken)
  assert.match(csrfCookie, /XSRF-TOKEN=/)

  const verifiedRequest = new Request('https://app.test/login', {
    method: 'POST',
    headers: {
      cookie: csrfCookie,
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': '203.0.113.7',
    },
    body: new URLSearchParams({
      [csrfField.name]: csrfToken,
    }),
  })
  await csrf.verify(verifiedRequest)
  await protect(new Request('https://app.test/login', {
    method: 'POST',
    headers: {
      cookie: csrfCookie,
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': '203.0.113.7',
    },
    body: new URLSearchParams({
      [csrfField.name]: csrfToken,
    }),
  }), { csrf: true })

  let csrfError = null
  try {
    await protect(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie: csrfCookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        [csrfField.name]: 'invalid-token',
      }),
    }), { csrf: true })
  } catch (error) {
    csrfError = error
  }
  assert.ok(csrfError instanceof SecurityCsrfError)

  assert.equal(await defaultRateLimitKey(new Request('https://app.test/api', {
    headers: {
      'x-forwarded-for': '198.51.100.20',
    },
  })), 'ip:198.51.100.20')

  const loginRequest = new Request('https://app.test/login', {
    headers: {
      'x-forwarded-for': '203.0.113.7',
    },
  })
  const loginRate = await rateLimit('login', {
    request: loginRequest,
    values: {
      email: 'ava@example.com',
    },
  })
  assert.equal(loginRate.limited, false)
  assert.equal(loginRate.snapshot.key, '203.0.113.7:ava@example.com')

  let rateLimitError = null
  try {
    await rateLimit('login', {
      request: loginRequest,
      values: {
        email: 'ava@example.com',
      },
    })
  } catch (error) {
    rateLimitError = error
  }
  assert.ok(rateLimitError instanceof SecurityRateLimitError)
  assert.equal(rateLimitError.status, 429)
  assert.equal(await clearRateLimit({
    limiter: 'login',
    key: '203.0.113.7:ava@example.com',
  }), true)
  assert.equal((await rateLimit('login', {
    request: loginRequest,
    values: {
      email: 'ava@example.com',
    },
  })).limited, false)

  const throttleRequest = new Request('https://app.test/api/orders', {
    headers: {
      'x-forwarded-for': '198.51.100.20',
    },
  })
  await protect(throttleRequest, { throttle: 'api' })
  let throttleError = null
  try {
    await protect(new Request('https://app.test/api/orders', {
      headers: {
        'x-forwarded-for': '198.51.100.20',
      },
    }), { throttle: 'api' })
  } catch (error) {
    throttleError = error
  }
  assert.ok(throttleError instanceof SecurityRateLimitError)
  assert.equal(await clearRateLimit({ limiter: 'api' }), 1)

  const fluxClient = createFluxClient({
    connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
  })
  const fluxDebug = fluxClient.__debug
  assert.ok(fluxDebug, 'Flux smoke did not expose the mock connector debug API.')
  const fluxEvents = []
  const fluxNotifications = []
  const fluxPresence = fluxClient.presence('chat.1')
  fluxClient.private('orders.1')
    .listen('orders.updated', payload => {
      fluxEvents.push(payload)
    })
    .notification(payload => {
      fluxNotifications.push(payload)
    })
  await fluxClient.connect()
  fluxDebug.emitEvent('orders.1', 'orders.updated', { id: 'ord_1', framework })
  fluxDebug.emitNotification('orders.1', { type: 'order.updated', framework })
  fluxDebug.updatePresenceMembers('chat.1', [{ id: \`\${framework}-user\` }])
  assert.deepEqual(fluxEvents, [{ id: 'ord_1', framework }])
  assert.deepEqual(fluxNotifications, [{ type: 'order.updated', framework }])
  assert.deepEqual(fluxPresence.members, [{ id: \`\${framework}-user\` }])
  await fluxClient.disconnect()
  assert.deepEqual(fluxDebug.getJoinedChannels(), [])

  const baseContext = {
    state: 'state-1',
    codeChallenge: 'challenge',
    codeVerifier: 'verifier',
    code: 'test-code',
  }

  const appleAuthorizationUrl = await appleSocialProvider.buildAuthorizationUrl({
    provider: 'apple',
    request: new Request('https://app.test/auth/apple'),
    state: baseContext.state,
    codeVerifier: baseContext.codeVerifier,
    codeChallenge: baseContext.codeChallenge,
    config: {
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'https://app.test/auth/apple/callback',
      scopes: [],
      encryptTokens: false,
    },
  })
  assert.match(appleAuthorizationUrl, /appleid\\.apple\\.com\\/auth\\/authorize/)
  installMockFetch([
    new Response(JSON.stringify({
      access_token: 'apple-access',
      refresh_token: 'apple-refresh',
      expires_in: 3600,
      id_token: createJwt({
        sub: 'apple-user',
        email: 'apple@example.com',
        email_verified: 'true',
        given_name: 'Apple',
        family_name: 'User',
      }),
    }), { status: 200 }),
  ])
  const appleExchange = await appleSocialProvider.exchangeCode({
    provider: 'apple',
    request: new Request('https://app.test/auth/apple/callback?code=test-code'),
    code: baseContext.code,
    codeVerifier: baseContext.codeVerifier,
    config: {
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'https://app.test/auth/apple/callback',
      scopes: [],
      encryptTokens: false,
    },
  })
  assert.equal(appleExchange.profile.id, 'apple-user')
  assert.equal(appleExchange.profile.email, 'apple@example.com')

  const discordAuthorizationUrl = await discordSocialProvider.buildAuthorizationUrl({
    provider: 'discord',
    request: new Request('https://app.test/auth/discord'),
    state: baseContext.state,
    codeVerifier: baseContext.codeVerifier,
    codeChallenge: baseContext.codeChallenge,
    config: {
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'https://app.test/auth/discord/callback',
      scopes: [],
      encryptTokens: false,
    },
  })
  assert.match(discordAuthorizationUrl, /discord\\.com\\/oauth2\\/authorize/)
  installMockFetch([
    new Response(JSON.stringify({
      access_token: 'discord-access',
      refresh_token: 'discord-refresh',
      expires_in: 3600,
    }), { status: 200 }),
    new Response(JSON.stringify({
      id: 'discord-user',
      username: 'octo',
      global_name: 'Octo',
      email: 'discord@example.com',
      verified: true,
      avatar: 'avatar-hash',
    }), { status: 200 }),
  ])
  const discordExchange = await discordSocialProvider.exchangeCode({
    provider: 'discord',
    request: new Request('https://app.test/auth/discord/callback?code=test-code'),
    code: baseContext.code,
    codeVerifier: baseContext.codeVerifier,
    config: {
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'https://app.test/auth/discord/callback',
      scopes: [],
      encryptTokens: false,
    },
  })
  assert.equal(discordExchange.profile.id, 'discord-user')
  assert.equal(discordExchange.profile.email, 'discord@example.com')

  const facebookAuthorizationUrl = await facebookSocialProvider.buildAuthorizationUrl({
    provider: 'facebook',
    request: new Request('https://app.test/auth/facebook'),
    state: baseContext.state,
    codeVerifier: baseContext.codeVerifier,
    codeChallenge: baseContext.codeChallenge,
    config: {
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'https://app.test/auth/facebook/callback',
      scopes: [],
      encryptTokens: false,
    },
  })
  assert.match(facebookAuthorizationUrl, /facebook\\.com\\/dialog\\/oauth/)
  installMockFetch([
    new Response(JSON.stringify({
      access_token: 'facebook-access',
      expires_in: 3600,
    }), { status: 200 }),
    new Response(JSON.stringify({
      id: 'facebook-user',
      name: 'Face Book',
      email: 'facebook@example.com',
      picture: {
        data: {
          url: 'https://example.com/avatar.png',
        },
      },
    }), { status: 200 }),
  ])
  const facebookExchange = await facebookSocialProvider.exchangeCode({
    provider: 'facebook',
    request: new Request('https://app.test/auth/facebook/callback?code=test-code'),
    code: baseContext.code,
    codeVerifier: baseContext.codeVerifier,
    config: {
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'https://app.test/auth/facebook/callback',
      scopes: [],
      encryptTokens: false,
    },
  })
  assert.equal(facebookExchange.profile.id, 'facebook-user')
  assert.equal(facebookExchange.profile.email, 'facebook@example.com')

  const githubAuthorizationUrl = await githubSocialProvider.buildAuthorizationUrl({
    provider: 'github',
    request: new Request('https://app.test/auth/github'),
    state: baseContext.state,
    codeVerifier: baseContext.codeVerifier,
    codeChallenge: baseContext.codeChallenge,
    config: {
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'https://app.test/auth/github/callback',
      scopes: [],
      encryptTokens: false,
    },
  })
  assert.match(githubAuthorizationUrl, /github\\.com\\/login\\/oauth\\/authorize/)
  installMockFetch([
    new Response(JSON.stringify({
      access_token: 'github-access',
      refresh_token: 'github-refresh',
    }), { status: 200 }),
    new Response(JSON.stringify({
      id: 42,
      login: 'octocat',
      name: 'Octo Cat',
      avatar_url: 'https://example.com/octo.png',
    }), { status: 200 }),
    new Response(JSON.stringify([
      { email: 'private@example.com', verified: false, primary: true },
      { email: 'verified@example.com', verified: true, primary: false },
    ]), { status: 200 }),
  ])
  const githubExchange = await githubSocialProvider.exchangeCode({
    provider: 'github',
    request: new Request('https://app.test/auth/github/callback?code=test-code'),
    code: baseContext.code,
    codeVerifier: baseContext.codeVerifier,
    config: {
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'https://app.test/auth/github/callback',
      scopes: [],
      encryptTokens: false,
    },
  })
  assert.equal(githubExchange.profile.id, '42')
  assert.equal(githubExchange.profile.email, 'verified@example.com')

  const linkedinAuthorizationUrl = await linkedinSocialProvider.buildAuthorizationUrl({
    provider: 'linkedin',
    request: new Request('https://app.test/auth/linkedin'),
    state: baseContext.state,
    codeVerifier: baseContext.codeVerifier,
    codeChallenge: baseContext.codeChallenge,
    config: {
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'https://app.test/auth/linkedin/callback',
      scopes: [],
      encryptTokens: false,
    },
  })
  assert.match(linkedinAuthorizationUrl, /linkedin\\.com\\/oauth\\/v2\\/authorization/)
  installMockFetch([
    new Response(JSON.stringify({
      access_token: 'linkedin-access',
      expires_in: 3600,
    }), { status: 200 }),
    new Response(JSON.stringify({
      sub: 'linkedin-user',
      email: 'linkedin@example.com',
      email_verified: true,
      name: 'Linked In',
      picture: 'https://example.com/linkedin.png',
    }), { status: 200 }),
  ])
  const linkedinExchange = await linkedinSocialProvider.exchangeCode({
    provider: 'linkedin',
    request: new Request('https://app.test/auth/linkedin/callback?code=test-code'),
    code: baseContext.code,
    codeVerifier: baseContext.codeVerifier,
    config: {
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'https://app.test/auth/linkedin/callback',
      scopes: [],
      encryptTokens: false,
    },
  })
  assert.equal(linkedinExchange.profile.id, 'linkedin-user')
  assert.equal(linkedinExchange.profile.email, 'linkedin@example.com')

  console.log(JSON.stringify({
    framework,
    mail: sentMail.messageId,
    notifications: notificationResult.channels.length,
    providers: ['apple', 'discord', 'facebook', 'github', 'linkedin'],
  }))
} finally {
  globalThis.fetch = originalFetch
}
`
}

function createFrameworkFluxHelperSmokeScript(app) {
  if (app.framework === 'next') {
    return `
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { createFluxClient, fluxInternals } from '@holo-js/flux'
import {
  useFluxConnectionStatus,
  useFluxPresence,
  useFluxPublic,
} from '@holo-js/flux-react'

const client = createFluxClient({
  connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
})
const debug = client.__debug
const events = []
const statusChanges = []
let controls
let presenceState
let renderer

function Probe() {
  controls = useFluxPublic('feed.1', 'feed.updated', payload => {
    events.push(payload)
  }, { client })
  presenceState = useFluxPresence('chat.1', {}, { client })
  useFluxConnectionStatus({
    client,
    onChange(status) {
      statusChanges.push(status)
    },
  })
  return createElement('div')
}

await act(async () => {
  renderer = create(createElement(Probe))
})
debug.emitEvent('feed.1', 'feed.updated', { id: 'evt_1' })
debug.updatePresenceMembers('chat.1', [{ id: 'react-user' }])
await act(async () => undefined)
await act(async () => {
  await client.connect()
  await client.disconnect()
})
assert.deepEqual(events, [{ id: 'evt_1' }])
assert.deepEqual(presenceState.members, [{ id: 'react-user' }])
assert.deepEqual(statusChanges, ['connecting', 'connected', 'disconnected'])
controls.leaveChannel()
presenceState.leaveChannel()
await act(async () => {
  renderer.unmount()
})
assert.deepEqual(debug.getJoinedChannels(), [])
console.log(JSON.stringify({ framework: 'next', helper: '@holo-js/flux-react' }))
`
  }

  if (app.framework === 'nuxt') {
    return `
import assert from 'node:assert/strict'
import { effectScope, nextTick } from 'vue'
import { createFluxClient, fluxInternals } from '@holo-js/flux'
import {
  useFluxConnectionStatus,
  useFluxPresence,
  useFluxPublic,
} from '@holo-js/flux-vue'

const client = createFluxClient({
  connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
})
const debug = client.__debug
const events = []
const statusChanges = []
const scope = effectScope()
let controls
let presenceState
let status

scope.run(() => {
  controls = useFluxPublic('feed.1', 'feed.updated', payload => {
    events.push(payload)
  }, { client })
  presenceState = useFluxPresence('chat.1', {}, { client })
  status = useFluxConnectionStatus({
    client,
    onChange(next) {
      statusChanges.push(next)
    },
  })
})

debug.emitEvent('feed.1', 'feed.updated', { id: 'evt_1' })
debug.updatePresenceMembers('chat.1', [{ id: 'vue-user' }])
await nextTick()
await client.connect()
await client.disconnect()
await nextTick()
assert.deepEqual(events, [{ id: 'evt_1' }])
assert.deepEqual(presenceState.members, [{ id: 'vue-user' }])
assert.equal(status.value, 'disconnected')
assert.deepEqual(statusChanges, ['connecting', 'connected', 'disconnected'])
controls.leaveChannel()
presenceState.leaveChannel()
scope.stop()
assert.deepEqual(debug.getJoinedChannels(), [])
console.log(JSON.stringify({ framework: 'nuxt', helper: '@holo-js/flux-vue' }))
`
  }

  return `
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { createFluxClient, fluxInternals } from '@holo-js/flux'
import {
  useFluxConnectionStatus,
  useFluxPresence,
  useFluxPublic,
} from '@holo-js/flux-svelte'

const client = createFluxClient({
  connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
})
const debug = client.__debug
const events = []
const statusChanges = []
const unmounts = []
const controls = useFluxPublic('feed.1', 'feed.updated', payload => {
  events.push(payload)
}, {
  client,
  onUnmount(cleanup) {
    unmounts.push(cleanup)
  },
})
const presenceState = useFluxPresence('chat.1', {}, {
  client,
  onUnmount(cleanup) {
    unmounts.push(cleanup)
  },
})
const status = useFluxConnectionStatus({
  client,
  onChange(next) {
    statusChanges.push(next)
  },
  onUnmount(cleanup) {
    unmounts.push(cleanup)
  },
})

debug.emitEvent('feed.1', 'feed.updated', { id: 'evt_1' })
debug.updatePresenceMembers('chat.1', [{ id: 'svelte-user' }])
await client.connect()
await client.disconnect()
assert.deepEqual(events, [{ id: 'evt_1' }])
assert.deepEqual(get(presenceState.members), [{ id: 'svelte-user' }])
assert.equal(get(status), 'disconnected')
assert.deepEqual(statusChanges, ['connecting', 'connected', 'disconnected'])
controls.leaveChannel()
presenceState.leaveChannel()
for (const cleanup of unmounts) {
  cleanup()
}
assert.deepEqual(debug.getJoinedChannels(), [])
console.log(JSON.stringify({ framework: 'sveltekit', helper: '@holo-js/flux-svelte' }))
`
}

async function runAdditionalPackageSmokeCheck(app) {
  await runCommand(app.cwd, 'node', ['--input-type=module', '--eval', createAdditionalPackageSmokeScript(app)])
}

async function runFrameworkFluxHelperSmokeCheck(app) {
  const helperCwd = app.framework === 'next'
    ? resolve(rootDir, 'packages/flux-react')
    : app.framework === 'nuxt'
      ? resolve(rootDir, 'packages/flux-vue')
      : resolve(rootDir, 'packages/flux-svelte')

  await runCommand(helperCwd, 'node', ['--input-type=module', '--eval', createFrameworkFluxHelperSmokeScript(app)])
}

function assertHealthPayload(app, payload) {
  assert.equal(payload.ok, true)
  assert.equal(payload.framework, app.framework)
  assert.equal(payload.app, app.appName)
  assert.equal(payload.defaultConnection, 'main')
  assert.equal(typeof payload.models, 'number')
  assert.equal(typeof payload.commands, 'number')
}

function assertMatrixPayload(app, payload) {
  assert.equal(payload.framework, app.framework)
  assert.equal(payload.app, app.appName)
  assert.equal(payload.ok, true)
  assert.equal(payload.config.defaultConnection, 'main')
  assert.equal(payload.config.defaultCache, 'file')
  assert.equal(payload.storage.localContents, 'private payload')
  assert.equal(payload.storage.publicContents, 'public payload')
  assert.equal(payload.storage.movedExists, true)
  assert.ok(payload.storage.publicFiles.includes('matrix/public.txt'))
  assert.ok(payload.storage.publicFiles.includes('matrix/public-moved.txt'))
  assert.equal(payload.queries.userCount, 3)
  assert.equal(payload.queries.emailCount, 3)
  assert.equal(payload.queries.apiClientCount, 3)
  assert.equal(payload.queries.deviceKeyCount, 2)
  assert.equal(payload.queries.alertCount, 3)
  assert.equal(payload.queries.mySqlLinkCount, 2)
  assert.equal(payload.queries.postgresLinkCount, 2)
  assert.equal(payload.queries.sqliteJson.theme, 'night')
  assert.equal(payload.queries.sqliteJson.dashboard, 'analytics')
  assert.equal(payload.queries.sqliteJson.themeCount, 1)
  assert.equal(payload.queries.sqliteJson.featureCount, 2)
  assert.ok(Array.isArray(payload.queries.chunkedIds))
  assert.ok(Array.isArray(payload.queries.chunkedById))
  assert.equal(payload.relations.uuidRelation.matchesForeignKey, true)
  assert.equal(payload.relations.uuidRelation.clientUserEmail, 'alice@matrix.test')
  assert.equal(payload.uuidPrimary.primaryKeyLookup.userEmail, 'alice@matrix.test')
  assert.ok(String(payload.uuidPrimary.primaryKeyLookup.id).length > 20)
  assert.match(String(payload.uuidPrimary.primaryKeyLookup.updatedLabel), /-updated$/)
  assert.ok(Array.isArray(payload.uuidPrimary.primaryKeyLookup.alertMessages))
  assert.equal(payload.uuidPrimary.polymorphicUuid.ownerLabel, 'primary-device-updated')
  assert.equal(payload.uuidPrimary.polymorphicUuid.alertableId, payload.uuidPrimary.polymorphicUuid.ownerId)
  assert.match(String(payload.uuidPrimary.polymorphicUuid.alertableType), /DeviceKey/)
  assert.ok(payload.uuidPrimary.webhookAlerts.includes('Webhook delivered successfully.'))
  assert.ok(payload.externalConnections.userPerspective.mysqlLabels.includes('mysql-primary-link'))
  assert.ok(payload.externalConnections.userPerspective.postgresLabels.includes('postgres-primary-link'))
  assert.ok(payload.externalConnections.devicePerspective.mysqlLabels.includes('mysql-primary-link'))
  assert.ok(payload.externalConnections.devicePerspective.postgresLabels.includes('postgres-primary-link'))
  assert.equal(payload.externalConnections.mysqlToMain.userEmail, 'alice@matrix.test')
  assert.equal(payload.externalConnections.mysqlToMain.deviceLabel, 'primary-device-updated')
  assert.equal(payload.externalConnections.mysqlToMain.meta.driver, 'mysql')
  assert.equal(payload.externalConnections.mysqlToMain.meta.status, 'verified')
  assert.equal(payload.externalConnections.postgresToMain.userEmail, 'alice@matrix.test')
  assert.equal(payload.externalConnections.postgresToMain.deviceLabel, 'primary-device-updated')
  assert.equal(payload.externalConnections.postgresToMain.metadata.driver, 'postgres')
  assert.equal(payload.externalConnections.postgresToMain.metadata.status, 'verified')
  assert.equal(payload.externalConnections.jsonQueries.mysqlDriverCount, 1)
  assert.equal(payload.externalConnections.jsonQueries.mysqlLabelCount, 2)
  assert.equal(payload.externalConnections.jsonQueries.postgresDriverCount, 1)
  assert.equal(payload.externalConnections.jsonQueries.postgresLabelCount, 2)
  assert.equal(payload.softDeletes.beforeActive, 3)
  assert.equal(payload.softDeletes.activeAfterDelete, 2)
  assert.equal(payload.softDeletes.withTrashedAfterDelete, 3)
  assert.equal(payload.softDeletes.trashedAfterDelete, 1)
  assert.equal(payload.softDeletes.deletedAtSet, true)
  assert.equal(payload.softDeletes.restoredActive, 3)
  assert.equal(payload.softDeletes.restoredTrashed, 0)
  assert.equal(payload.softDeletes.restoredDeletedAtCleared, true)
  assert.equal(payload.transactions.rolledBack, true)
  assert.equal(payload.cache.default.driver, 'file')
  assert.equal(payload.cache.default.hit.framework, app.framework)
  assert.equal(payload.cache.default.remembered.computeRuns, 1)
  assert.equal(payload.cache.default.flexible.step, 'fresh')
  assert.equal(payload.cache.memory.driver, 'memory')
  assert.equal(payload.cache.memory.hit.scope, 'process')
  assert.equal(payload.media.mediaCount, 2)
  assert.ok(payload.media.imageUrl.includes(`/storage/media/`))
  assert.ok(payload.media.thumbUrl.includes(`/storage/media/`))
  assert.ok(payload.media.audioUrl.includes(`/storage/media/`))
  assert.match(payload.negative.fillableError, /not writable/)
  assert.match(payload.negative.undefinedColumnError, /not defined/)
  assert.match(payload.negative.undefinedValueError, /cannot be undefined/)
  assert.match(payload.negative.duplicateEmailError, /UNIQUE constraint failed/)
  assert.match(payload.negative.invalidUuidForeignKeyError, /FOREIGN KEY constraint failed/)
  assert.equal(payload.negative.duplicatePivotPrevented, true)
  assert.match(payload.negative.privateDiskUrlError, /is private/)
}

function assertAudioPayload(app, payload) {
  assert.equal(payload.framework, app.framework)
  assert.equal(payload.app, app.appName)
  assert.equal(payload.ok, true)
  assert.equal(payload.collection, 'audio')
  assert.equal(payload.fileName, 'matrix-theme.mp3')
  assert.ok(payload.audioUrl.includes(`/storage/media/`))
  assert.ok(payload.audioPath.includes('storage/app/public/media/'))
  assert.ok(Array.isArray(payload.publicFiles))
  assert.ok(payload.publicFiles.some(value => value.endsWith('/matrix-theme.mp3')))
}

function assertFormsSmokePayload(app, payload) {
  assert.equal(payload.ok, true)
  assert.equal(payload.framework, app.framework)

  // validation: safeParse valid
  assert.equal(payload.safeParseValid, true)
  assert.deepEqual(payload.safeParseValidData, { name: 'Alice', email: 'alice@test.com', age: 25 })

  // validation: safeParse invalid
  assert.equal(payload.safeParseInvalidValid, false)
  assert.ok(payload.safeParseInvalidErrorKeys.includes('name'))
  assert.ok(payload.safeParseInvalidErrorKeys.includes('email'))
  assert.ok(payload.safeParseInvalidErrorKeys.includes('age'))
  assert.ok(payload.safeParseInvalidNameErrors.length > 0)
  assert.ok(payload.safeParseInvalidEmailErrors.length > 0)
  assert.ok(payload.safeParseInvalidAgeErrors.length > 0)

  // validation: parse
  assert.deepEqual(payload.parsedData, { name: 'Bob', email: 'bob@test.com', age: 30 })
  assert.equal(payload.parseThrew, true)
  assert.ok(payload.parseThrewName.length > 0, 'parse() should throw a named Error subclass')

  // validation: errorBag
  assert.equal(payload.errorBagHasEmail, true)
  assert.equal(payload.errorBagHasName, false)
  assert.equal(payload.errorBagEmailFirst, 'taken')
  assert.deepEqual(payload.errorBagCityMessages, ['required', 'too short'])
  assert.deepEqual(payload.errorBagFlatKeys, ['email', 'profile.city'])

  // forms: schema identity
  assert.equal(payload.isFormSchemaResult, true)
  assert.equal(payload.isFormSchemaOnPlainObject, false)
  assert.equal(payload.formSchemaMode, 'form')

  // forms: valid submission
  assert.equal(payload.formValidValid, true)
  assert.equal(payload.formValidSubmitted, true)
  assert.deepEqual(payload.formValidData, { name: 'Alice', email: 'alice@test.com', age: 25 })
  assert.equal(payload.formValidSerializedValid, true)
  assert.equal(payload.formValidSuccessOk, true)
  assert.equal(payload.formValidSuccessStatus, 200)

  // forms: invalid submission
  assert.equal(payload.formInvalidValid, false)
  assert.equal(payload.formInvalidSubmitted, true)
  assert.equal(payload.formInvalidData, undefined)
  assert.ok(payload.formInvalidErrorKeys.includes('name'))
  assert.ok(payload.formInvalidErrorKeys.includes('email'))
  assert.ok(payload.formInvalidErrorKeys.includes('age'))
  assert.equal(payload.formInvalidFailOk, false)
  assert.equal(payload.formInvalidFailStatus, 422)
  assert.equal(payload.formInvalidSerializedValid, false)
}

function assertAuthSmokePayload(app, payload) {
  assert.equal(payload.ok, true)
  assert.equal(payload.framework, app.framework)
  assert.equal(payload.helpers.initialCheck, false)
  assert.equal(payload.helpers.initialId, null)
  assert.equal(payload.helpers.initialUser, true)
  assert.equal(payload.helpers.defaultCurrentAccessTokenNull, true)
  assert.equal(payload.helpers.helperHashLooksHashed, true)
  assert.equal(payload.helpers.helperVerifyWorks, true)
  assert.equal(payload.helpers.helperRejectsWrongPassword, true)
  assert.equal(payload.helpers.helperNeedsRehashFalse, true)

  assert.match(payload.registration.email, /@matrix\.test$/)
  assert.equal(payload.registration.storedPasswordHashed, true)
  assert.equal(payload.registration.missingIdentifierRejected, true)
  assert.equal(payload.registration.mismatchRejected, true)
  assert.equal(payload.registration.duplicateRejected, true)

  assert.equal(payload.verification.deliveryCount, 2)
  assert.equal(payload.verification.deliveryCaptured, true)
  assert.equal(payload.verification.deliveredEmail, payload.registration.email)
  assert.equal(payload.verification.invalidFormatRejected, true)
  assert.equal(payload.verification.invalidSecretRejected, true)
  assert.equal(payload.verification.expiredRejected, true)
  assert.equal(payload.verification.preVerificationLoginRejected, true)
  assert.equal(payload.verification.userVerified, true)
  assert.equal(payload.verification.consumedEmail, payload.registration.email)
  assert.equal(payload.verification.replayRejected, true)
  assert.equal(payload.verification.consumedTokenCleared, true)
  assert.equal(payload.verification.expiredTokenPersisted, true)

  assert.equal(payload.sessions.missingIdentifierLoginRejected, true)
  assert.equal(payload.sessions.invalidUserRejected, true)
  assert.equal(payload.sessions.invalidPasswordRejected, true)
  assert.equal(payload.sessions.loginCookiesIssued, true)
  assert.equal(payload.sessions.sessionCookiePresent, true)
  assert.equal(payload.sessions.rememberCookiePresent, true)
  assert.equal(payload.sessions.sessionStore, 'database')
  assert.equal(payload.sessions.sessionRememberStored, true)
  assert.equal(payload.sessions.payloadUserEmail, payload.registration.email)
  assert.equal(payload.sessions.restoredCheck, true)
  assert.equal(payload.sessions.restoredId, payload.trusted.loginUsingUserId)
  assert.equal(payload.sessions.restoredUserEmail, payload.registration.email)
  assert.equal(payload.sessions.restoredRefreshedEmail, payload.registration.email)
  assert.equal(payload.sessions.sessionGuardCurrentTokenNull, true)
  assert.match(payload.sessions.cachedNameBeforeMutation, new RegExp(`${app.framework} auth smoke`, 'i'))
  assert.equal(payload.sessions.cachedNameAfterMutation, payload.sessions.cachedNameBeforeMutation)
  assert.match(payload.sessions.refreshedNameAfterMutation, new RegExp(`${app.framework} auth updated`, 'i'))
  assert.equal(payload.sessions.rememberTokenConsumableAfterExpiry, true)
  assert.equal(payload.sessions.rememberConsumedPayloadEmail, payload.registration.email)
  assert.equal(payload.sessions.logoutCookies >= 1, true)
  assert.equal(payload.sessions.sessionInvalidatedOnLogout, true)

  assert.equal(payload.trusted.loginUsingRemembered, true)
  assert.equal(payload.trusted.loginUsingCheck, true)
  assert.equal(payload.trusted.loginUsingUserId, payload.sessions.restoredId)
  assert.equal(payload.trusted.loginUsingLogoutCookies >= 1, true)
  assert.equal(payload.trusted.loginUsingIdSession, true)
  assert.equal(payload.trusted.loginUsingIdUserEmail, payload.registration.email)
  assert.equal(payload.trusted.loginUsingIdLogoutCookies >= 1, true)

  assert.equal(payload.impersonation.sameGuardStarted, true)
  assert.match(payload.impersonation.sameGuardUserEmail, /target-.*@matrix\.test$/)
  assert.match(payload.impersonation.sameGuardActorEmail, /actor-.*@matrix\.test$/)
  assert.equal(payload.impersonation.sameGuardOriginalUserEmail, payload.impersonation.sameGuardActorEmail)
  assert.equal(payload.impersonation.sameGuardRememberPreserved, true)
  assert.equal(payload.impersonation.sameGuardStopRestoredEmail, payload.impersonation.sameGuardActorEmail)
  assert.equal(payload.impersonation.sameGuardUserAfterStop, payload.impersonation.sameGuardActorEmail)
  assert.equal(payload.impersonation.sameGuardCleared, true)
  assert.equal(payload.impersonation.sameGuardLogoutCookies >= 1, true)
  assert.equal(payload.impersonation.crossGuardSessionShared, true)
  assert.equal(payload.impersonation.crossGuardStarted, true)
  assert.equal(payload.impersonation.crossGuardActorGuard, 'admin')
  assert.match(payload.impersonation.crossGuardActorEmail, /admin-.*@matrix\.test$/)
  assert.equal(payload.impersonation.crossGuardOriginalUserNull, true)
  assert.equal(payload.impersonation.duplicateCrossGuardRejected, true)
  assert.equal(payload.impersonation.crossGuardStopReturnedNull, true)
  assert.equal(payload.impersonation.crossGuardWebCleared, true)
  assert.equal(payload.impersonation.crossGuardAdminStillAuthenticated, true)
  assert.equal(payload.impersonation.crossGuardAdminLogoutCookies >= 1, true)

  assert.equal(payload.tokens.listedCount, 2)
  assert.equal(payload.tokens.authenticatedUserEmail, payload.registration.email)
  assert.equal(payload.tokens.canReadOrders, true)
  assert.equal(payload.tokens.cannotDeleteOrders, true)
  assert.equal(payload.tokens.invalidAbilityCheck, false)
  assert.equal(payload.tokens.revokeCurrentCheckBefore, true)
  assert.equal(payload.tokens.revokeCurrentUserEmail, payload.registration.email)
  assert.equal(payload.tokens.revokeCurrentTokenName, 'primary-api')
  assert.deepEqual(payload.tokens.revokeCurrentAbilities, ['orders.read'])
  assert.equal(payload.tokens.revokeCurrentCleared, true)
  assert.equal(payload.tokens.deleteCurrentTokenName, 'secondary-api')
  assert.equal(payload.tokens.deleteCurrentCleared, true)
  assert.equal(payload.tokens.revokeWithoutActiveTokenCompleted, true)
  assert.equal(payload.tokens.revokeAllCount, 2)
  assert.equal(Array.isArray(payload.tokens.revokedTokenIds), true)
  assert.equal(payload.tokens.revokedTokenIds.length, 2)
  assert.match(payload.tokens.otherUserTokenStillValid, /other-.*@matrix\.test$/)
  assert.equal(payload.tokens.malformedTokenCheck, false)
  assert.equal(payload.tokens.malformedTokenUserNull, true)
  assert.equal(payload.tokens.malformedTokenCurrentNull, true)
  assert.equal(payload.tokens.malformedTokenRefreshNull, true)
  assert.equal(payload.tokens.wrongSecretTokenCheck, false)
  assert.equal(payload.tokens.wrongSecretTokenUserNull, true)
  assert.equal(payload.tokens.wrongSecretTokenCurrentNull, true)
  assert.equal(payload.tokens.missingTokenCheck, false)
  assert.equal(payload.tokens.missingTokenUserNull, true)
  assert.equal(payload.tokens.partialTokenCheck, false)
  assert.equal(payload.tokens.partialTokenUserNull, true)
  assert.equal(payload.tokens.expiredTokenCheck, false)
  assert.equal(payload.tokens.expiredTokenUserNull, true)
  assert.equal(payload.tokens.apiLogoutCleared, true)

  assert.equal(payload.passwords.blankEmailRejected, true)
  assert.equal(payload.passwords.missingUserNoDelivery, true)
  assert.equal(payload.passwords.invalidTokenRejected, true)
  assert.equal(payload.passwords.missingConfirmationRejected, true)
  assert.equal(payload.passwords.mismatchConfirmationRejected, true)
  assert.equal(payload.passwords.firstDeliveryCount, 4)
  assert.equal(payload.passwords.firstTokenInvalidated, true)
  assert.equal(payload.passwords.consumedEmail, payload.registration.email)
  assert.equal(payload.passwords.expiredRejected, true)
  assert.equal(payload.passwords.throttledBrokerSingleDelivery, true)
  assert.equal(payload.passwords.throttledBrokerRows, 1)
  assert.equal(payload.passwords.oldPasswordRejected, true)

  assert.equal(payload.logoutAll.namedGuardCount, 1)
  assert.equal(payload.logoutAll.namedGuardSessionCleared, true)
  assert.equal(payload.logoutAll.namedGuardCookies >= 1, true)
  assert.equal(payload.logoutAll.sharedSessionReused, true)
  assert.equal(payload.logoutAll.sharedWebEmail, payload.registration.email)
  assert.match(payload.logoutAll.sharedAdminEmail, /admin-.*@matrix\.test$/)
  assert.equal(payload.logoutAll.allGuardsCount, 4)
  assert.deepEqual(payload.logoutAll.resultGuards, ['web', 'admin', 'api', 'staff'])
  assert.equal(payload.logoutAll.webLoggedOut, true)
  assert.equal(payload.logoutAll.adminLoggedOut, true)
  assert.equal(payload.logoutAll.apiLoggedOut, true)
  assert.equal(payload.logoutAll.sharedSessionCleared, true)
  assert.equal(payload.logoutAll.scopedHostedCookiesRootPath, true)

  assert.equal(payload.social.missingProviderRejected, true)
  assert.equal(payload.social.missingProviderRuntimeRejected, true)
  assert.equal(payload.social.missingRuntimeRejected, true)
  assert.equal(payload.social.redirectHasState, true)
  assert.equal(payload.social.redirectHasPkce, true)
  assert.equal(payload.social.invalidStateStatus, 400)
  assert.equal(payload.social.invalidStateMessage, 'Invalid or expired OAuth state.')
  assert.equal(payload.social.missingParamsStatus, 400)
  assert.equal(payload.social.missingParamsMessage, 'Missing OAuth state or code.')
  assert.equal(payload.social.linkedIdentityPreservedLocalUser, true)
  assert.equal(payload.social.linkedIdentitySessionStored, true)
  assert.equal(payload.social.verifiedEmailLinkedExistingUser, true)
  assert.equal(payload.social.createdViaFormPost, true)
  assert.match(payload.social.createdUserEmail, /social-created-.*@matrix\.test$/)
  assert.equal(payload.social.createdTokensEncrypted, true)
  assert.equal(payload.social.createdTokensDecryptable, true)
  assert.equal(payload.social.mappedProviderStoredOnIdentity, true)
  assert.equal(payload.social.mappedProviderSessionPayload, true)
  assert.equal(payload.social.adminGuardStoredOnIdentity, true)
  assert.equal(payload.social.adminGuardSessionPayload, true)
  assert.equal(payload.social.adminTokensDecryptable, true)
  assert.equal(payload.social.unverifiedVerifiedEmailPolicyRejected, true)
  assert.equal(payload.social.unverifiedIdentityNotCreated, true)
  assert.equal(payload.social.pkceMismatchRejected, true)
  assert.equal(payload.social.tokenGuardRejected, true)
  assert.equal(payload.social.verificationOptionalSyntheticEmail, true)

  assert.equal(payload.workos.missingProviderRejected, true)
  assert.equal(payload.workos.missingRuntimeRejected, true)
  assert.equal(payload.workos.missingTokenNull, true)
  assert.equal(payload.workos.createdStatus, 'created')
  assert.equal(payload.workos.createdGuard, 'admin')
  assert.equal(payload.workos.createdSessionCookie, true)
  assert.equal(payload.workos.createdIdentityStored, true)
  assert.equal(payload.workos.updatedStatus, 'updated')
  assert.equal(payload.workos.updatedLocalUserName, 'WorkOS Updated')
  assert.equal(payload.workos.updatedIdentityProfile, true)
  assert.equal(payload.workos.linkedByVerifiedEmail, true)
  assert.equal(payload.workos.staffGuardCreated, true)
  assert.equal(payload.workos.tokenGuardRejected, true)
  assert.equal(payload.workos.unverifiedRejected, true)
  assert.equal(payload.workos.emailCollisionRejected, true)
  assert.equal(payload.workos.existingLinkRejected, true)
  assert.equal(payload.workos.cookieRequestAuthenticated, true)
  assert.equal(payload.workos.cookieRequestReusedSession, true)
  assert.equal(payload.workos.logoutClearsHostedCookie, true)

  assert.equal(payload.clerk.missingProviderRejected, true)
  assert.equal(payload.clerk.missingRuntimeRejected, true)
  assert.equal(payload.clerk.missingTokenNull, true)
  assert.equal(payload.clerk.createdStatus, 'created')
  assert.equal(payload.clerk.createdGuard, 'web')
  assert.equal(payload.clerk.createdSessionCookie, true)
  assert.equal(payload.clerk.updatedStatus, 'updated')
  assert.equal(payload.clerk.updatedLocalUserName, 'Clerk Updated')
  assert.equal(payload.clerk.updatedIdentityProfile, true)
  assert.equal(payload.clerk.relinkedMissingLocalUser, true)
  assert.equal(payload.clerk.staffGuardCreated, true)
  assert.equal(payload.clerk.tokenGuardRejected, true)
  assert.equal(payload.clerk.unverifiedRejected, true)
  assert.equal(payload.clerk.emailCollisionRejected, true)
  assert.equal(payload.clerk.existingLinkRejected, true)
  assert.equal(payload.clerk.cookieRequestAuthenticated, true)
  assert.equal(payload.clerk.cookieRequestReusedSession, true)
  assert.equal(payload.clerk.logoutClearsHostedCookie, true)
}

async function validateFrameworkApp(app) {
  const env = {
    APP_URL: `http://127.0.0.1:${app.port}`,
    MYSQL_DATABASE: mysqlDatabaseName,
    POSTGRES_DATABASE: postgresDatabaseName,
  }

  await ensureExternalDatabases()
  await cleanupAppStorage(app)
  await runCommand(app.cwd, 'bunx', ['holo', 'prepare'], env)
  await runCommand(app.cwd, 'bunx', ['holo', 'migrate:fresh', '--seed', '--force'], env)
  assert.equal(await pathExists(join(app.cwd, 'server/db/schema.generated.ts')), true)

  await runCommand(app.cwd, 'bun', ['run', 'config:cache'], env)
  const cachePath = join(app.cwd, '.holo-js/generated/config-cache.json')
  assert.equal(await pathExists(cachePath), true)
  await runCommand(app.cwd, 'bun', ['run', 'config:clear'], env)
  assert.equal(await pathExists(cachePath), false)

  const report = await runCommand(app.cwd, 'bunx', ['holo', 'matrix:report'], env)
  const reportPayload = JSON.parse(report.stdout)
  assert.equal(reportPayload.app, app.appName)
  assert.equal(reportPayload.defaultConnection, 'main')
  assert.equal(reportPayload.registry.models, 16)
  assert.equal(reportPayload.registry.commands, 1)
  await runPortableStorageSmokeCheck(app, env)
  await runAdditionalPackageSmokeCheck(app)
  await runFrameworkFluxHelperSmokeCheck(app)

  await runCommand(app.cwd, 'bun', ['run', 'build'], env)

  const server = await startServer(app)
  try {
    const baseUrl = `http://127.0.0.1:${app.port}`
    const health = await fetchJson(`${baseUrl}/api/holo/health`)
    assertHealthPayload(app, health)

    const matrix = await fetchJson(`${baseUrl}/api/holo/matrix`)
    assertMatrixPayload(app, matrix)

    await fetchBinary(matrix.storage.publicUrl, 'text/plain')
    await fetchBinary(matrix.media.imageUrl, 'image/png')
    await fetchBinary(matrix.media.thumbUrl, 'image/png')

    const audio = await fetchJson(`${baseUrl}/api/holo/audio`)
    assertAudioPayload(app, audio)
    await fetchBinary(audio.audioUrl, 'audio/mpeg')
    await runEventSmokeCheck(app, baseUrl, env)
    await runQueueSmokeCheck(app, baseUrl, env)

    const forms = await fetchJson(`${baseUrl}/api/holo/forms`)
    assertFormsSmokePayload(app, forms)

    const auth = await fetchJson(`${baseUrl}/api/holo/auth`)
    assertAuthSmokePayload(app, auth)
    await runAuthorizationSmokeCheck(app, baseUrl)
    await runBroadcastSmokeCheck(app, baseUrl)
  } finally {
    await server.stop()
    await cleanupAppStorage(app)
  }
}

function resolveAppsToValidate(options) {
  if (!options.framework) {
    return frameworkApps.map(app => ({
      ...app,
      dependencyOverrides: {},
    }))
  }

  const app = frameworkApps.find(candidate => candidate.framework === options.framework)
  if (!app) {
    throw new Error(`Unknown framework "${options.framework}". Expected one of: ${frameworkApps.map(candidate => candidate.framework).join(', ')}`)
  }

  return [{
    ...app,
    dependencyOverrides: options.dependencyOverrides,
  }]
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  assertSmokeCoverageDefinitions()

  if (options.help) {
    printUsage()
    return
  }

  const appsToValidate = resolveAppsToValidate(options)

  if (options.dryRun) {
    for (const app of appsToValidate) {
      log('plan', `${app.framework}: cwd=${app.cwd} overrides=${JSON.stringify(app.dependencyOverrides)}`)
    }
    return
  }

  await buildWorkspacePackages()

  for (const app of appsToValidate) {
    log('start', `Validating ${app.framework} app in ${app.cwd}`)
    await withDependencyOverrides(app, app.dependencyOverrides, async () => {
      await validateFrameworkApp(app)
    })
    log('done', `${app.framework} app passed`)
  }

  log('success', 'All framework smoke apps passed the full validation matrix.')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
