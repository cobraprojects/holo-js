import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { documentedSetupCommands, setupFailures } from './validate-contributor-setup.mjs'
import { exampleApps } from './setup-example-apps.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const migratedSchema = 'export const tables = { "posts": posts } as const\n'
const unmigratedSchema = 'export const tables = {} as const\n'
const keyedEnv = 'APP_KEY=base64:a\nBROADCAST_APP_KEY=b\n'

async function writeApp(root, name, { manifest = { scripts: { setup: 'holo migrate' } }, env, schema } = {}) {
  await mkdir(join(root, 'apps', name, '.holo-js/generated'), { recursive: true })
  await writeFile(join(root, 'apps', name, 'package.json'), JSON.stringify(manifest))
  if (env !== undefined) await writeFile(join(root, 'apps', name, '.env'), env)
  if (schema !== undefined) await writeFile(join(root, 'apps', name, '.holo-js/generated/schema.generated.ts'), schema)
}

test('the documented contributor setup installs, builds, then sets up the example apps', async () => {
  const markdown = await readFile(join(repoRoot, 'apps/docs/docs/advanced/contributing.md'), 'utf8')
  assert.deepEqual(documentedSetupCommands(markdown), ['bun install', 'bun run build', 'bun run setup:examples'])
})

test('contributor setup commands come from the setup section after the clone steps', () => {
  const markdown = [
    '# Contributing',
    '',
    '```bash',
    'echo unrelated',
    '```',
    '',
    '## Set up the repository',
    '',
    '```bash',
    'git clone https://example.test/holo-js.git',
    'cd holo-js',
    '',
    'bun install',
    'bun run build',
    '```',
    '',
    '```bash',
    'echo later',
    '```',
  ].join('\n')
  assert.deepEqual(documentedSetupCommands(markdown), ['bun install', 'bun run build'])
})

test('contributor setup reads a docs page checked out with Windows line endings', () => {
  const markdown = '## Set up the repository\r\n\r\n```bash\r\ngit clone https://example.test/holo-js.git\r\ncd holo-js\r\nbun install\r\n```\r\n'
  assert.deepEqual(documentedSetupCommands(markdown), ['bun install'])
})

test('contributor setup rejects a docs page without clone steps or a setup section', () => {
  assert.throws(() => documentedSetupCommands('# Contributing\n'), /no "## Set up the repository" section/)
  assert.throws(() => documentedSetupCommands('## Set up the repository\n\nRun it.\n'), /no bash block/)
  assert.throws(
    () => documentedSetupCommands('## Set up the repository\n\n```bash\nbun install\n```\n'),
    /must start with git clone and cd/,
  )
})

test('contributor setup fails when no example app can be set up', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-contributor-setup-'))
  try {
    await mkdir(join(root, 'apps'))
    assert.deepEqual(setupFailures(root), ['No example app defines a setup script.'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('contributor setup requires generated app and broadcast keys in every example app', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-contributor-setup-'))
  try {
    await writeApp(root, 'blog-next', { env: keyedEnv, schema: migratedSchema })
    await writeApp(root, 'blog-nuxt', { env: 'APP_KEY=\nBROADCAST_APP_KEY=b\n', schema: migratedSchema })
    await writeApp(root, 'blog-sveltekit', { schema: migratedSchema })
    await writeApp(root, 'docs', { manifest: { scripts: { dev: 'vitepress dev docs' } } })
    assert.deepEqual(setupFailures(root), [
      'apps/blog-nuxt/.env has no APP_KEY.',
      'apps/blog-sveltekit/.env has no APP_KEY.',
      'apps/blog-sveltekit/.env has no BROADCAST_APP_KEY.',
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('contributor setup requires every example app to have a generated schema from its migrated database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-contributor-setup-'))
  try {
    await writeApp(root, 'blog-next', { env: keyedEnv, schema: migratedSchema })
    await writeApp(root, 'blog-nuxt', { env: keyedEnv, schema: unmigratedSchema })
    await writeApp(root, 'blog-sveltekit', { env: keyedEnv })
    assert.deepEqual(setupFailures(root), [
      'apps/blog-nuxt/.holo-js/generated/schema.generated.ts has no tables. The app\'s setup script must run holo migrate.',
      'apps/blog-sveltekit/.holo-js/generated/schema.generated.ts has no tables. The app\'s setup script must run holo migrate.',
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('every example app migrates its database during setup', async () => {
  for (const app of exampleApps(repoRoot)) {
    const manifest = JSON.parse(await readFile(join(repoRoot, 'apps', app, 'package.json'), 'utf8'))
    assert.match(manifest.scripts.setup, /&& holo migrate$/, `apps/${app} setup must end with holo migrate`)
  }
})
