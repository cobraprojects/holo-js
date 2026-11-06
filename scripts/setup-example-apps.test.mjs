import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { exampleApps, selectExampleApps } from './setup-example-apps.mjs'

const repoRoot = resolve(import.meta.dirname, '..')

async function writeApp(root, name, scripts) {
  await mkdir(join(root, 'apps', name), { recursive: true })
  await writeFile(join(root, 'apps', name, 'package.json'), JSON.stringify({ name, scripts }))
}

test('example app setup only covers apps with a setup script', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-setup-examples-'))
  try {
    await writeApp(root, 'blog-sveltekit', { setup: 'holo prepare' })
    await writeApp(root, 'blog-next', { setup: 'holo prepare' })
    await writeApp(root, 'docs', { dev: 'vitepress dev docs' })
    await mkdir(join(root, 'apps', 'empty'))
    assert.deepEqual(exampleApps(root), ['blog-next', 'blog-sveltekit'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('example app setup selects every app by default and rejects unknown names', () => {
  const available = ['blog-next', 'blog-nuxt', 'blog-sveltekit']
  assert.deepEqual(selectExampleApps(available, []), available)
  assert.deepEqual(selectExampleApps(available, ['blog-nuxt']), ['blog-nuxt'])
  assert.throws(() => selectExampleApps(available, ['nuxt']), /Unknown example app: nuxt\. Choose from blog-next, blog-nuxt, blog-sveltekit\./)
})

test('example apps run no holo or framework command from install lifecycle scripts', async () => {
  const lifecycleScripts = ['preinstall', 'install', 'postinstall', 'prepare', 'preprepare', 'postprepare']
  for (const app of exampleApps(repoRoot)) {
    const manifest = JSON.parse(await readFile(join(repoRoot, 'apps', app, 'package.json'), 'utf8'))
    for (const script of lifecycleScripts) {
      assert.equal(manifest.scripts[script], undefined, `apps/${app} must not define a ${script} script`)
    }
  }
  assert.deepEqual(exampleApps(repoRoot), ['blog-next', 'blog-nuxt', 'blog-sveltekit'])
})

test('example app test runners only run scripts their app defines', async () => {
  for (const app of exampleApps(repoRoot)) {
    const manifest = JSON.parse(await readFile(join(repoRoot, 'apps', app, 'package.json'), 'utf8'))
    const runner = await readFile(join(repoRoot, 'apps', app, 'tests/run.mjs'), 'utf8')
    const scripts = [...runner.matchAll(/\(\s*'bun',\s*\[\s*'run',\s*'([^']+)'/g)].map(match => match[1])
    assert.ok(scripts.length > 0, `apps/${app}/tests/run.mjs runs no package scripts`)
    for (const script of scripts) {
      assert.ok(manifest.scripts[script], `apps/${app}/tests/run.mjs runs missing script ${script}`)
    }
  }
})
