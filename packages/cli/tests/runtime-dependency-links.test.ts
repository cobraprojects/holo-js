import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { bundleProjectModule } from '../src/project/runtime'
import { runRuntimeInvocation } from '../src/runtime'

it('keeps bundled model imports usable after another invocation removes its runtime dependencies', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'holo-cli-dependency-'))
  onTestFinished(() => rm(projectRoot, { recursive: true, force: true }))
  const nodeModules = join(projectRoot, '.holo-js/runtime/cli/node_modules')
  await mkdir(join(nodeModules, '@holo-js'), { recursive: true })
  await symlink(resolve(import.meta.dirname, '../../db'), join(nodeModules, '@holo-js/db'), 'junction')
  await writeFile(join(projectRoot, 'package.json'), '{"type":"module"}')
  const modelPath = join(projectRoot, 'Media.mjs')
  await writeFile(modelPath, "import { defineModel } from '@holo-js/db'\nprocess.stdout.write(typeof defineModel)\n")

  const bundled = await bundleProjectModule(projectRoot, modelPath, { external: ['@holo-js/db'] })
  await rm(nodeModules, { recursive: true, force: true })
  const result = await runRuntimeInvocation(process.execPath, [bundled.path], {
    cwd: projectRoot,
    env: process.env,
  })

  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toBe('function')
})

it('loads external Holo packages from paths containing URL delimiters', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'holo-cli-#dependency-'))
  onTestFinished(() => rm(projectRoot, { recursive: true, force: true }))
  const packageRoot = join(projectRoot, 'node_modules/@holo-js/dependency')
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(projectRoot, 'package.json'), '{"type":"module"}')
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ type: 'module', exports: './index.mjs' }))
  await writeFile(join(packageRoot, 'index.mjs'), "export default 'loaded'\n")
  const entry = join(projectRoot, 'entry.mjs')
  await writeFile(entry, "import value from '@holo-js/dependency'\nprocess.stdout.write(value)\n")

  const bundled = await bundleProjectModule(projectRoot, entry)
  const result = await runRuntimeInvocation(process.execPath, [bundled.path], {
    cwd: projectRoot,
    env: process.env,
  })

  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toBe('loaded')
})
