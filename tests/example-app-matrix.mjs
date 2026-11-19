import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { closeWriteStream, exampleAppRunVariable, stopTaggedProcesses } from './example-app-process.mjs'
import { createExampleAppFixture } from './support/example-app-fixture.mjs'
import { watchExampleAppFiles } from './support/example-app-file-watch.mjs'
import { exampleAppDrivers, exampleAppServerProvisioning } from './support/example-app-databases.mjs'

const root = resolve(import.meta.dirname, '..')
const pg = createRequire(join(root, 'packages/db-postgres/package.json'))('pg')
const mysql = createRequire(join(root, 'packages/db-mysql/package.json'))('mysql2/promise')
const frameworks = process.env.HOLO_TEST_FRAMEWORK ? [process.env.HOLO_TEST_FRAMEWORK] : ['next', 'nuxt', 'sveltekit']
const drivers = process.env.HOLO_TEST_DRIVER ? [process.env.HOLO_TEST_DRIVER] : exampleAppDrivers
const compiledMarker = 'Compiled in'
const postgresServer = {
  host: process.env.HOLO_POSTGRES_HOST ?? '127.0.0.1',
  port: Number(process.env.HOLO_POSTGRES_PORT ?? 5432),
  user: process.env.HOLO_POSTGRES_USER ?? 'postgres',
  password: process.env.HOLO_POSTGRES_PASSWORD,
}
const mysqlServer = {
  host: process.env.HOLO_MYSQL_HOST ?? '127.0.0.1',
  port: Number(process.env.HOLO_MYSQL_PORT ?? 3306),
  user: process.env.HOLO_MYSQL_USER ?? 'root',
  password: process.env.HOLO_MYSQL_PASSWORD ?? '',
}

async function withPostgresAdmin(task) {
  const client = new pg.Client({ ...postgresServer, database: 'postgres' })
  await client.connect()
  try {
    await task(client)
  } finally {
    await client.end()
  }
}

async function withMysqlAdmin(task) {
  const connection = await mysql.createConnection(mysqlServer)
  try {
    await task(connection)
  } finally {
    await connection.end()
  }
}

async function runApp(framework, driver) {
  assert.ok(['next', 'nuxt', 'sveltekit'].includes(framework))
  assert.ok(exampleAppDrivers.includes(driver))
  const fixture = await createExampleAppFixture(root, framework)
  const { projectRoot } = fixture
  const name = `holo_app_${randomUUID().replaceAll('-', '')}`
  const insertOnlyRole = `${name}_writer`
  const password = randomUUID()
  const filename = join(projectRoot, 'storage', `${name}.sqlite`)
  const env = { ...process.env, [exampleAppRunVariable]: name, DB_DRIVER: driver, SESSION_DRIVER: 'database', SESSION_CONNECTION: 'main' }
  const provisioning = exampleAppServerProvisioning(driver, {
    postgres: {
      create: () => withPostgresAdmin(async (admin) => {
        await admin.query(`CREATE ROLE ${name} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`)
        await admin.query(`CREATE ROLE ${insertOnlyRole} NOLOGIN NOSUPERUSER NOBYPASSRLS`)
        await admin.query(`GRANT ${insertOnlyRole} TO ${name}`)
        await admin.query(`CREATE DATABASE ${name} OWNER ${name}`)
        env.DB_POSTGRES_URL = `postgresql://${name}:${password}@${postgresServer.host}:${postgresServer.port}/${name}`
        env.HOLO_POSTGRES_INSERT_ONLY_ROLE = insertOnlyRole
      }),
      drop: () => withPostgresAdmin(async (admin) => {
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
        await admin.query(`DROP ROLE IF EXISTS ${name}`)
        await admin.query(`DROP ROLE IF EXISTS ${insertOnlyRole}`)
      }),
    },
    mysql: {
      create: () => withMysqlAdmin(async (admin) => {
        await admin.query(`CREATE DATABASE ${name}`)
        env.DB_MYSQL_URL = `mysql://${encodeURIComponent(mysqlServer.user)}:${encodeURIComponent(mysqlServer.password)}@${mysqlServer.host}:${mysqlServer.port}/${name}`
      }),
      drop: () => withMysqlAdmin(admin => admin.query(`DROP DATABASE IF EXISTS ${name}`)),
    },
  })
  const logPath = join(root, 'coverage', `app-${framework}-${driver}.log`)
  const fileWatch = watchExampleAppFiles(fixture.directory)
  const compiledAt = []
  let output = ''
  let log
  let failure
  try {
    {
      const generatedBroadcastKey = (await readFile(join(projectRoot, '.env'), 'utf8').catch(() => '')).match(/^BROADCAST_APP_KEY=(.+)$/m)?.[1]?.trim()
      if (!env.BROADCAST_APP_KEY && generatedBroadcastKey) env.BROADCAST_APP_KEY = generatedBroadcastKey
      assert.ok(env.BROADCAST_APP_KEY, `${framework} example app .env must define BROADCAST_APP_KEY; run bun run setup:examples blog-${framework} to generate it`)
    }
    await provisioning.create()
    await mkdir(join(projectRoot, 'storage'), { recursive: true })
    await writeFile(filename, '')
    env.DB_SQLITE_URL = filename
    env.DB_URL = env[`DB_${driver.toUpperCase()}_URL`]
    await mkdir(join(root, 'coverage'), { recursive: true })
    log = createWriteStream(logPath)
    // A failed log write must not crash the run; closeWriteStream reports it during cleanup.
    log.on('error', () => {})
    const child = spawn(process.execPath, ['tests/run.mjs'], { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const capture = (chunk) => {
      const searchFrom = Math.max(0, output.length - compiledMarker.length + 1)
      output += chunk.toString()
      if (output.indexOf(compiledMarker, searchFrom) !== -1) compiledAt.push(Date.now())
      log.write(chunk)
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    const closed = new Promise(resolve => child.once('close', resolve))
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (exitCode, signal) => resolve(exitCode ?? signal))
    })
    // Anything the journey left running (dev servers, workers) still writes to storage/ and holds the output pipes.
    const leftRunning = await stopTaggedProcesses(name)
    await closed
    if (compiledAt.length > 0 || code !== 0) {
      const report = `\n${fileWatch.before(code === 0 ? compiledAt : [...compiledAt, Date.now()])}\n`
      output += report
      log.write(report)
    }
    if (leftRunning.length > 0) {
      const report = `${framework}/${driver} app journey left ${leftRunning.length} process(es) running after it exited; stopped them before cleanup:\n${leftRunning.map(({ pid, command }) => `  ${pid} ${command}`).join('\n')}\n`
      output += report
      log.write(report)
    }
    const unprompted = compiledAt.filter(at => !fileWatch.hasSourceEditBefore(at)).length
    if (unprompted > 0 && process.env.GITHUB_ACTIONS) {
      process.stdout.write(`::warning title=Unprompted Next HMR compile (#380)::${framework}/${driver} printed '${compiledMarker}' ${unprompted} time(s) without a source edit. File changes before each are at the end of ${relative(root, logPath)} in the example-app-logs-${framework} artifact.\n`)
    }
    assert.equal(code, 0, `${framework}/${driver} app journey failed.\n${output}`)
    assert.deepEqual(leftRunning, [], `${framework}/${driver} app journey must stop every process it started.\n${output}`)
  } catch (error) {
    failure = error
  }
  // Every cleanup step runs, and none of their errors replaces the journey's own failure.
  const cleanupErrors = []
  const attempt = async (step) => {
    try {
      await step()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  fileWatch.close()
  await attempt(() => stopTaggedProcesses(name))
  await attempt(async () => {
    await mkdir(join(root, 'coverage'), { recursive: true })
    await writeFile(logPath, output)
    await writeFile(join(root, 'coverage', `app-${framework}-${driver}-files.log`), fileWatch.log())
  })
  if (log) await attempt(() => closeWriteStream(log))
  for (const drop of provisioning.cleanups()) await attempt(drop)
  await attempt(() => Promise.all(['', '-wal', '-shm'].map(suffix => rm(`${filename}${suffix}`, { force: true }))))
  await attempt(() => rm(fixture.directory, { recursive: true, force: true }))
  if (failure && cleanupErrors.length > 0) throw new AggregateError([failure, ...cleanupErrors], failure.message)
  if (failure) throw failure
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, `${framework}/${driver} example app cleanup failed`)
}

test('real example app database matrix', { concurrency: 3 }, async suite => {
  await Promise.all(frameworks.map(framework => suite.test(framework, async app => {
    for (const driver of drivers) {
      await app.test(driver, () => runApp(framework, driver))
    }
  })))
})
