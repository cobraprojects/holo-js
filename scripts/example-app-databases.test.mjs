import assert from 'node:assert/strict'
import { test } from 'node:test'
import { exampleAppConnections, exampleAppServerProvisioning } from '../tests/support/example-app-databases.mjs'

function recordingServers(calls, failing) {
  const server = name => ({
    create: async () => {
      calls.push(`create ${name}`)
      if (failing === name) throw new Error(`${name} unreachable`)
    },
    drop: async () => {
      calls.push(`drop ${name}`)
    },
  })
  return { postgres: server('postgres'), mysql: server('mysql') }
}

async function provisionAndClean(driver, failing) {
  const calls = []
  const provisioning = exampleAppServerProvisioning(driver, recordingServers(calls, failing))
  const created = await provisioning.create().then(() => undefined, error => error)
  for (const drop of provisioning.cleanups()) await drop()
  return { calls, created }
}

test('each driver run exercises SQLite and only the driver under test', () => {
  assert.deepEqual(exampleAppConnections('sqlite'), ['sqlite'])
  assert.deepEqual(exampleAppConnections('postgres'), ['sqlite', 'postgres'])
  assert.deepEqual(exampleAppConnections('mysql'), ['sqlite', 'mysql'])
})

test('rejects a driver the example apps do not support', () => {
  assert.throws(() => exampleAppConnections('sqlserver'), /sqlserver/)
  assert.throws(() => exampleAppConnections(undefined), /undefined/)
})

test('a SQLite run provisions no database server', async () => {
  assert.deepEqual(await provisionAndClean('sqlite'), { calls: [], created: undefined })
})

test('PostgreSQL and MySQL runs provision and clean up only their own server', async () => {
  assert.deepEqual(await provisionAndClean('postgres'), { calls: ['create postgres', 'drop postgres'], created: undefined })
  assert.deepEqual(await provisionAndClean('mysql'), { calls: ['create mysql', 'drop mysql'], created: undefined })
})

test('a server whose provisioning fails is still cleaned up', async () => {
  const { calls, created } = await provisionAndClean('postgres', 'postgres')
  assert.match(created.message, /postgres unreachable/)
  assert.deepEqual(calls, ['create postgres', 'drop postgres'])
})
