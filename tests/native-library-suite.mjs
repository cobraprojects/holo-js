import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
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

function run(label, command, args, cwd = root, extraEnv = {}) {
  process.stdout.write(`Starting ${label}\n`)
  const result = spawnSync(command, args, {
    cwd,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  writeFileSync(join(resultsRoot, `${label.replaceAll('/', '-')}.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`)
  results.push({ label, status: result.status, error: result.error?.message })
  process.stdout.write(`${label}: ${result.status}\n`)
}

mkdirSync(resultsRoot, { recursive: true })
await postgres.connect()
try {
  mysqlAdmin = await mysql.createConnection({ host: '127.0.0.1', port: 3306, user: 'root' })
  await postgres.query(`CREATE DATABASE ${name}`)
  await mysqlAdmin.query(`CREATE DATABASE ${name}`)

  const policyScript = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts['test:dependency-policy']
  run('dependency-policy', '/bin/sh', ['-c', policyScript.replace('node --test ', 'node --test --test-concurrency=4 ')])
  for (const directory of readdirSync(join(root, 'packages'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()) {
    const cwd = join(root, 'packages', directory)
    const manifestPath = join(cwd, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const script = manifest.scripts?.test
    if (!script) continue
    let phase = 0
    const command = script.replace(/\bvitest\b/g, () => `npx vitest --pool forks --fileParallelism --maxWorkers 4 --reporter=json --outputFile=../../coverage/native-libraries/${directory}-${phase++}.json`)
    run(`packages/${directory}`, '/bin/sh', ['-c', command], cwd)
  }
  run('cache-redis-live', 'npx', [
    'vitest', 'run', '--pool', 'forks', '--fileParallelism', '--maxWorkers', '4', '--reporter=json',
    `--outputFile=${join(resultsRoot, 'cache-redis-live.json')}`,
  ], join(root, 'packages/cache-redis'), { HOLO_REDIS_INTEGRATION: '1' })
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
