import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { collectGeneratedTargets } from './run-generated-eslint.mjs'

let repoRoot

after(async () => {
  if (repoRoot) {
    await rm(repoRoot, { recursive: true, force: true })
  }
})

test('generated eslint targets include nested generated files and framework runner', async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'holo-generated-eslint-'))
  const appRoot = join(repoRoot, 'apps/example')
  const frameworkRunPath = join(appRoot, '.holo-js/framework/run.mjs')
  const generatedRootPath = join(appRoot, '.holo-js/generated/root.ts')
  const nestedGeneratedPath = join(appRoot, '.holo-js/generated/authorization/registry.ts')
  const ignoredGeneratedPath = join(appRoot, '.holo-js/generated/authorization/notes.md')

  await mkdir(join(appRoot, '.holo-js/framework'), { recursive: true })
  await mkdir(join(appRoot, '.holo-js/generated/authorization'), { recursive: true })
  await writeFile(frameworkRunPath, '', 'utf8')
  await writeFile(generatedRootPath, '', 'utf8')
  await writeFile(nestedGeneratedPath, '', 'utf8')
  await writeFile(ignoredGeneratedPath, '', 'utf8')

  assert.deepEqual(await collectGeneratedTargets(appRoot), [
    frameworkRunPath,
    nestedGeneratedPath,
    generatedRootPath,
  ].sort())
})
