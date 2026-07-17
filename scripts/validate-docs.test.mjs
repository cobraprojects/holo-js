import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { validateDocs } from './validate-docs.mjs'

test('documentation validator accepts feature imports and existing routes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-docs-'))
  await mkdir(join(root, 'guide'))
  await writeFile(join(root, 'index.md'), "import { defineAuthConfig } from '@holo-js/auth'\n[Guide](/guide/)")
  await writeFile(join(root, 'guide/index.md'), '# Guide')
  assert.deepEqual(validateDocs(root), [])
})

test('documentation validator rejects old config imports and missing routes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-docs-'))
  await writeFile(join(root, 'index.md'), "import { defineQueueConfig } from '@holo-js/config'\nimport { defineHoloPlugin } from '@holo-js/cli'\n[Missing](/missing)")
  const failures = validateDocs(root).join('\n')
  assert.match(failures, /feature config helper/)
  assert.match(failures, /defineHoloPlugin/)
  assert.match(failures, /missing route \/missing/)
})

test('documentation validator syntax-checks TypeScript examples and accepts object fragments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-docs-'))
  await writeFile(join(root, 'index.md'), [
    '```ts',
    "providers: { users: { model: 'User' } },",
    '```',
    '```ts',
    'const invalid: = true',
    '```',
  ].join('\n'))
  const failures = validateDocs(root)
  assert.equal(failures.length, 1)
  assert.match(failures[0], /invalid TypeScript example/)
})

test('documentation validator verifies documented workspace package exports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-docs-'))
  await writeFile(join(root, 'index.md'), [
    '```ts',
    "import { defineHoloPlugin, missingKernelExport } from '@holo-js/kernel'",
    'void defineHoloPlugin',
    'void missingKernelExport',
    '```',
  ].join('\n'))
  const failures = validateDocs(root)
  assert.equal(failures.length, 1)
  assert.match(failures[0], /missing export missingKernelExport from @holo-js\/kernel/)
})
