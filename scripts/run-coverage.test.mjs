import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { discoverCoverageJobs } from './run-coverage.mjs'

test('coverage runner discovers every root coverage script', async () => {
  const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'))
  const expectedScripts = Object.keys(packageJson.scripts)
    .filter(scriptName => /^test:.+:coverage$/.test(scriptName))
    .sort()
  const discoveredScripts = discoverCoverageJobs(packageJson)
    .map(job => job.scriptName)
    .sort()

  assert.deepEqual(discoveredScripts, expectedScripts)
})

test('coverage runner derives coverage directories from script names', () => {
  assert.deepEqual(discoverCoverageJobs({
    scripts: {
      'test:coverage': 'node scripts/run-coverage.mjs',
      'test:auth-social:coverage': 'vitest --coverage',
      'test:queue-db:coverage': 'vitest --coverage',
    },
  }), [
    { scriptName: 'test:auth-social:coverage', directoryName: 'auth-social' },
    { scriptName: 'test:queue-db:coverage', directoryName: 'queue-db' },
  ])
})
