import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { ensureRuntimeDependencyLink, resolvePackageRootFromSpecifier } from '../src/runtime'

it('resolves the current database package after an interrupted invocation leaves an obsolete link', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'holo-cli-dependency-'))
  onTestFinished(() => rm(projectRoot, { recursive: true, force: true }))
  const nodeModules = join(projectRoot, '.holo-js/runtime/cli/node_modules')
  const obsoletePackage = join(projectRoot, 'obsolete-db')
  const dependencyPath = join(nodeModules, '@holo-js/db')
  await mkdir(obsoletePackage)
  await mkdir(join(nodeModules, '@holo-js'), { recursive: true })
  await symlink(obsoletePackage, dependencyPath, 'junction')
  await writeFile(join(nodeModules, '.holo-js-runtime-refs'), '1')

  await ensureRuntimeDependencyLink(projectRoot)

  expect(await realpath(dependencyPath)).toBe(await realpath(await resolvePackageRootFromSpecifier('@holo-js/db')))
})
