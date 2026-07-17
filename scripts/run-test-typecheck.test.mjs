import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { removeStaleGeneratedConfigs } from './remove-stale-test-typecheck-configs.mjs'

let testRoot

afterEach(async () => {
  if (testRoot) {
    await rm(testRoot, { recursive: true, force: true })
    testRoot = undefined
  }
})

test('removes stale generated config directories without removing other entries', async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'holo-test-typecheck-cleanup-'))
  const generatedConfigsPrefix = join(testRoot, '.holo-test-typecheck-')
  const staleDirectoryNames = [
    '.holo-test-typecheck-first',
    '.holo-test-typecheck-second',
  ]

  await Promise.all(staleDirectoryNames.map(directoryName => (
    mkdir(join(testRoot, directoryName))
  )))
  await mkdir(join(testRoot, '.holo-test-typecheck'))
  await writeFile(join(testRoot, '.holo-test-typecheck-file'), '')

  await removeStaleGeneratedConfigs(generatedConfigsPrefix)

  expect(await readdir(testRoot)).toEqual([
    '.holo-test-typecheck',
    '.holo-test-typecheck-file',
  ])
})
