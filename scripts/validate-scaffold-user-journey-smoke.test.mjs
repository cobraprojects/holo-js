import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

const repoRoot = join(import.meta.dirname, '..')

test('scaffold smoke owns the complete three-framework user journey', async () => {
  const source = await readFile(join(repoRoot, 'scripts/validate-scaffold-user-journey-smoke.mjs'), 'utf8')

  for (const framework of ['nuxt', 'next', 'sveltekit']) {
    assert.match(source, new RegExp(`framework: '${framework}'`))
  }

  for (const command of ['new', 'prepare', 'migrate', 'lint', 'typecheck', 'build', 'start']) {
    assert.match(source, new RegExp(`'${command}'`))
  }

  assert.match(source, /\.holo-js\/generated\/next\/holo\.ts/)
  assert.match(source, /\.holo-js\/generated\/sveltekit\/holo\.ts/)
  assert.match(source, /--overlay-local-packages/)
  assert.match(source, /HOLO_SMOKE_SCRIPT/)
  assert.match(source, /waitForRenderedApp/)
})

test('blog apps use the scaffold lifecycle contract', async () => {
  for (const appName of ['blog-nuxt', 'blog-next', 'blog-sveltekit']) {
    const manifest = JSON.parse(await readFile(join(repoRoot, 'apps', appName, 'package.json'), 'utf8'))
    const gitignore = await readFile(join(repoRoot, 'apps', appName, '.gitignore'), 'utf8')
    const eslintConfig = await readFile(join(repoRoot, 'apps', appName, 'eslint.config.mjs'), 'utf8')

    assert.equal(manifest.scripts.prepare, 'holo key:generate && holo prepare')
    assert.equal(manifest.scripts.dev, 'holo dev')
    assert.equal(manifest.scripts.build, 'holo build')
    assert.equal(manifest.scripts.start, 'holo start')
    assert.equal(manifest.scripts['holo:dev'], undefined)
    assert.equal(manifest.scripts['holo:build'], undefined)
    assert.equal(manifest.devDependencies['typescript-eslint'], 'catalog:')
    assert.match(gitignore, /^\.holo-js\/framework$/m)
    assert.match(eslintConfig, /tseslint\.configs\.recommended/)
  }
})
