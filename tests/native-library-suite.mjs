import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { parseShard, readLibrarySuiteDurations, selectShardTasks } from '../scripts/library-suite-shards.mjs'

const root = resolve(import.meta.dirname, '..')
const { values: options } = parseArgs({
  options: {
    'skip-build': { type: 'boolean', default: false },
    shard: { type: 'string', default: '1/1' },
  },
})
const shard = parseShard(options.shard)
const resultsRoot = join(root, 'coverage', 'native-libraries')
const pg = createRequire(join(root, 'packages/db-postgres/package.json'))('pg')
const mysql = createRequire(join(root, 'packages/db-mysql/package.json'))('mysql2/promise')
const name = `holo_suite_${randomUUID().replaceAll('-', '')}`
const postgres = new pg.Client({ host: '127.0.0.1', port: 5432, user: 'postgres', database: 'postgres' })
const env = {
  ...process.env,
  HOLO_POSTGRES_INTEGRATION: '1',
  HOLO_POSTGRES_HOST: '127.0.0.1',
  HOLO_POSTGRES_PORT: '5432',
  HOLO_POSTGRES_DATABASE: name,
  HOLO_MYSQL_INTEGRATION: '1',
  HOLO_MYSQL_DATABASE: name,
  HOLO_SESSION_REAL_REDIS: '1',
  HOLO_SECURITY_REAL_REDIS_URL: 'redis://127.0.0.1:6379',
  HOLO_QUEUE_REDIS_INTEGRATION: '1',
  HOLO_AUTH_REDEMPTION_POSTGRES_DATABASE: name,
  HOLO_AUTH_REDEMPTION_POSTGRES_HOST: '127.0.0.1',
  HOLO_AUTH_REDEMPTION_POSTGRES_PORT: '5432',
  HOLO_AUTH_REDEMPTION_MYSQL_DATABASE: name,
  HOLO_AUTH_REDEMPTION_MYSQL_PORT: '3306',
}
const results = []
let mysqlAdmin

function run({ label, command, args, cwd = root, extraEnv = {}, reportPaths = [] }) {
  process.stdout.write(`Starting ${label}\n`)
  for (const reportPath of reportPaths) rmSync(reportPath, { force: true })
  const result = spawnSync(command, args, {
    cwd,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  writeFileSync(join(resultsRoot, `${label.replaceAll('/', '-')}.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`)
  results.push({ label, status: result.status, error: result.error?.message })
  process.stdout.write(`${label}: ${result.status}\n`)
  if (result.status !== 0) {
    process.stderr.write(`${result.stdout ?? ''}${result.stderr ?? ''}`)
    if (result.error) process.stderr.write(`${result.error.message}\n`)
    for (const reportPath of reportPaths) {
      if (!existsSync(reportPath)) continue
      const report = JSON.parse(readFileSync(reportPath, 'utf8'))
      for (const suite of report.testResults) {
        if (suite.message) process.stderr.write(`${suite.name}\n${suite.message}\n`)
        for (const test of suite.assertionResults) {
          if (test.status === 'failed') process.stderr.write(`${test.fullName}\n${test.failureMessages.join('\n')}\n`)
        }
      }
    }
  }
}

function collectTasks() {
  const policyScript = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts['test:dependency-policy']
  const tasks = [{
    label: 'dependency-policy',
    command: '/bin/sh',
    args: ['-c', policyScript.replace('node --test ', 'node --test --test-concurrency=4 ')],
  }]
  for (const directory of readdirSync(join(root, 'packages'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()) {
    const cwd = join(root, 'packages', directory)
    const manifestPath = join(cwd, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const script = manifest.scripts?.test
    if (!script) continue
    let phase = 0
    const reportPaths = []
    const command = script.replace(/\bvitest\b/g, () => {
      const filename = `${directory}-${phase++}.json`
      reportPaths.push(join(resultsRoot, filename))
      return `npx vitest --pool forks --fileParallelism --maxWorkers 4 --reporter=json --outputFile=../../coverage/native-libraries/${filename}`
    })
    tasks.push({ label: `packages/${directory}`, command: '/bin/sh', args: ['-c', command], cwd, reportPaths })
  }
  tasks.push({
    label: 'cache-redis-live',
    command: 'npx',
    args: [
      'vitest', 'run', '--pool', 'forks', '--fileParallelism', '--maxWorkers', '4', '--reporter=json',
      `--outputFile=${join(resultsRoot, 'cache-redis-live.json')}`,
    ],
    cwd: join(root, 'packages/cache-redis'),
    extraEnv: { HOLO_REDIS_INTEGRATION: '1' },
    reportPaths: [join(resultsRoot, 'cache-redis-live.json')],
  })
  return tasks
}

mkdirSync(resultsRoot, { recursive: true })
await postgres.connect()
try {
  mysqlAdmin = await mysql.createConnection({ host: '127.0.0.1', port: 3306, user: 'root' })
  await postgres.query(`CREATE DATABASE ${name}`)
  await mysqlAdmin.query(`CREATE DATABASE ${name}`)

  if (!options['skip-build']) {
    run({ label: 'library-build', command: process.execPath, args: ['scripts/build-libraries.mjs'] })
    if (results.at(-1).status !== 0) throw new Error('Native package tests require a successful library build.')
  }

  for (const task of selectShardTasks(collectTasks(), shard, readLibrarySuiteDurations(root))) run(task)
} finally {
  writeFileSync(join(resultsRoot, 'summary.json'), JSON.stringify(results, null, 2))
  try {
    await postgres.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
  } finally {
    await postgres.end()
    if (mysqlAdmin) {
      try {
        await mysqlAdmin.query(`DROP DATABASE IF EXISTS ${name}`)
      } finally {
        await mysqlAdmin.end()
      }
    }
  }
}
process.exitCode = results.some(result => result.status !== 0) ? 1 : 0
