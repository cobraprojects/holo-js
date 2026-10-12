import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..')
const pg = createRequire(join(root, 'packages/db-postgres/package.json'))('pg')
const mysql = createRequire(join(root, 'packages/db-mysql/package.json'))('mysql2/promise')
const frameworks = process.env.HOLO_TEST_FRAMEWORK ? [process.env.HOLO_TEST_FRAMEWORK] : ['next', 'nuxt', 'sveltekit']
const drivers = process.env.HOLO_TEST_DRIVER ? [process.env.HOLO_TEST_DRIVER] : ['sqlite', 'postgres', 'mysql']

async function runApp(framework, driver) {
  assert.ok(['next', 'nuxt', 'sveltekit'].includes(framework))
  assert.ok(['sqlite', 'postgres', 'mysql'].includes(driver))
  const projectRoot = join(root, `apps/blog-${framework}`)
  const name = `holo_app_${randomUUID().replaceAll('-', '')}`
  const insertOnlyRole = `${name}_writer`
  const password = randomUUID()
  const filename = join(projectRoot, 'storage', `${name}.sqlite`)
  let postgresAdmin
  let mysqlAdmin
  const env = { ...process.env, DB_DRIVER: driver, SESSION_DRIVER: 'database', SESSION_CONNECTION: 'main' }
  const logPath = join(root, 'coverage', `app-${framework}-${driver}.log`)
  let output = ''
  let log
  try {
    {
      const host = process.env.HOLO_POSTGRES_HOST ?? '127.0.0.1'
      const port = Number(process.env.HOLO_POSTGRES_PORT ?? 5432)
      const client = new pg.Client({ host, port, user: process.env.HOLO_POSTGRES_USER ?? 'postgres', password: process.env.HOLO_POSTGRES_PASSWORD, database: 'postgres' })
      await client.connect()
      postgresAdmin = client
      await postgresAdmin.query(`CREATE ROLE ${name} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`)
      await postgresAdmin.query(`CREATE ROLE ${insertOnlyRole} NOLOGIN NOSUPERUSER NOBYPASSRLS`)
      await postgresAdmin.query(`GRANT ${insertOnlyRole} TO ${name}`)
      await postgresAdmin.query(`CREATE DATABASE ${name} OWNER ${name}`)
      env.DB_POSTGRES_URL = `postgresql://${name}:${password}@${host}:${port}/${name}`
      env.HOLO_POSTGRES_INSERT_ONLY_ROLE = insertOnlyRole
    }
    {
      const host = process.env.HOLO_MYSQL_HOST ?? '127.0.0.1'
      const port = Number(process.env.HOLO_MYSQL_PORT ?? 3306)
      const user = process.env.HOLO_MYSQL_USER ?? 'root'
      const password = process.env.HOLO_MYSQL_PASSWORD ?? ''
      mysqlAdmin = await mysql.createConnection({ host, port, user, password })
      await mysqlAdmin.query(`CREATE DATABASE ${name}`)
      env.DB_MYSQL_URL = `mysql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${name}`
    }
    env.DB_SQLITE_URL = filename
    env.DB_URL = env[`DB_${driver.toUpperCase()}_URL`]
    await mkdir(join(root, 'coverage'), { recursive: true })
    log = createWriteStream(logPath)
    const child = spawn(process.execPath, ['tests/run.mjs'], { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', chunk => { output += chunk.toString(); log.write(chunk) })
    child.stderr.on('data', chunk => { output += chunk.toString(); log.write(chunk) })
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    assert.equal(code, 0, `${framework}/${driver} app journey failed.\n${output}`)
  } finally {
    if (log) await new Promise((resolve, reject) => { log.once('error', reject); log.end(resolve) })
    await mkdir(join(root, 'coverage'), { recursive: true })
    await writeFile(logPath, output)
    try {
      if (postgresAdmin) {
        await postgresAdmin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
        await postgresAdmin.query(`DROP ROLE IF EXISTS ${name}`)
        await postgresAdmin.query(`DROP ROLE IF EXISTS ${insertOnlyRole}`)
        await postgresAdmin.end()
      }
    } finally {
      try {
        if (mysqlAdmin) {
          await mysqlAdmin.query(`DROP DATABASE IF EXISTS ${name}`)
          await mysqlAdmin.end()
        }
      } finally {
        await Promise.all(['', '-wal', '-shm'].map(suffix => rm(`${filename}${suffix}`, { force: true })))
      }
    }
  }
}

test('real example app database matrix', { concurrency: 3 }, async suite => {
  await Promise.all(frameworks.map(framework => suite.test(framework, async app => {
    for (const driver of drivers) {
      await app.test(driver, () => runApp(framework, driver))
    }
  })))
})
