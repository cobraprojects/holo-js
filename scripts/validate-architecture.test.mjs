import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { validateArchitecture } from './validate-architecture.mjs'

async function createPackage(root, name, dependencies = {}, source = '') {
  const directory = name.slice('@holo-js/'.length)
  const packageRoot = join(root, 'packages', directory)
  await mkdir(join(packageRoot, 'src'), { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name,
    exports: { '.': './dist/index.mjs', './public': './dist/public.mjs' },
    dependencies,
  }))
  await writeFile(join(packageRoot, 'src/index.ts'), source)
}

test('architecture validator accepts one-way declared public imports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-architecture-'))
  await createPackage(root, '@holo-js/kernel')
  await createPackage(root, '@holo-js/feature', { '@holo-js/kernel': 'catalog:' }, "export { value } from '@holo-js/kernel/public'")
  assert.deepEqual(validateArchitecture(root), [])
})

test('architecture validator reports cycles, undeclared imports, internal paths, and invalid layers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-architecture-'))
  await createPackage(root, '@holo-js/kernel', { '@holo-js/feature': 'catalog:' })
  await createPackage(root, '@holo-js/feature', { '@holo-js/kernel': 'catalog:' }, "import '@holo-js/missing'; import('@holo-js/kernel/internal')")
  await createPackage(root, '@holo-js/db', { '@holo-js/db-postgres': 'catalog:' })
  await createPackage(root, '@holo-js/db-postgres', { '@holo-js/db': 'catalog:' })
  await createPackage(root, '@holo-js/config', { '@holo-js/feature': 'catalog:' }, "import '@holo-js/feature/public'")
  const failures = validateArchitecture(root).join('\n')
  assert.match(failures, /kernel must not depend/)
  assert.match(failures, /imports undeclared dependency @holo-js\/missing/)
  assert.match(failures, /imports non-exported subpath @holo-js\/kernel\/internal/)
  assert.match(failures, /must not depend on concrete package/)
  assert.match(failures, /config must not depend on feature package/)
  assert.match(failures, /config\/src\/index.ts imports feature package/)
  assert.match(failures, /Workspace dependency cycle/)
})
