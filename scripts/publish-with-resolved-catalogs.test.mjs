import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, test } from 'node:test'
import {
  validateNpmPublishAuthentication,
  withResolvedCatalogManifests,
} from './publish-with-resolved-catalogs.mjs'

const tempRoots = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(repoRoot => rm(repoRoot, {
    recursive: true,
    force: true,
  })))
})

async function createTempRepo(files) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'holo-publish-catalogs-'))
  tempRoots.push(repoRoot)

  for (const [filePath, contents] of Object.entries(files)) {
    const targetPath = join(repoRoot, filePath)
    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(targetPath, contents.join('\n'), 'utf8')
  }

  return repoRoot
}

test('catalog resolver restores package manifests after publishing fails', async () => {
  const originalManifest = [
    '{',
    '  "name": "@holo-js/example",',
    '  "version": "0.1.4",',
    '  "dependencies": {',
    '    "@holo-js/core": "catalog:"',
    '  }',
    '}',
    '',
  ].join('\n')

  const repoRoot = await createTempRepo({
    'package.json': [
      '{',
      '  "workspaces": {',
      '    "catalog": {',
      '      "@holo-js/core": "^0.1.4"',
      '    }',
      '  }',
      '}',
      '',
    ],
    'packages/example/package.json': originalManifest.split('\n'),
  })

  await assert.rejects(
    withResolvedCatalogManifests(async () => {
      const resolvedManifest = JSON.parse(await readFile(join(repoRoot, 'packages/example/package.json'), 'utf8'))
      assert.equal(resolvedManifest.dependencies['@holo-js/core'], '^0.1.4')
      throw new Error('publish failed')
    }, repoRoot),
    /publish failed/,
  )

  assert.equal(await readFile(join(repoRoot, 'packages/example/package.json'), 'utf8'), originalManifest)
})

test('catalog manifest publishing skips package directories without package manifests', async () => {
  const originalManifest = [
    '{',
    '  "name": "@holo-js/example",',
    '  "version": "0.1.4",',
    '  "dependencies": {',
    '    "@holo-js/core": "catalog:"',
    '  }',
    '}',
    '',
  ].join('\n')

  const repoRoot = await createTempRepo({
    'package.json': [
      '{',
      '  "workspaces": {',
      '    "catalog": {',
      '      "@holo-js/core": "^0.1.4"',
      '    }',
      '  }',
      '}',
      '',
    ],
    'packages/example/package.json': originalManifest.split('\n'),
    'packages/not-a-package/.keep': [''],
  })

  await withResolvedCatalogManifests(async () => {
    const resolvedManifest = JSON.parse(await readFile(join(repoRoot, 'packages/example/package.json'), 'utf8'))
    assert.equal(resolvedManifest.dependencies['@holo-js/core'], '^0.1.4')
  }, repoRoot)

  assert.equal(await readFile(join(repoRoot, 'packages/example/package.json'), 'utf8'), originalManifest)
})

test('npm publish authentication preflight returns the authenticated user', () => {
  const calls = []
  const user = validateNpmPublishAuthentication({
    root: '/repo',
    spawn: (command, args, options) => {
      calls.push({ command, args, options })

      return {
        status: 0,
        stdout: 'cobra\n',
        stderr: '',
      }
    },
  })

  assert.equal(user, 'cobra')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, ['whoami'])
  assert.equal(calls[0].options.cwd, '/repo')
  assert.equal(calls[0].options.encoding, 'utf8')
})

test('npm publish authentication preflight rejects invalid npm credentials', () => {
  assert.throws(
    () => validateNpmPublishAuthentication({
      root: '/repo',
      spawn: () => ({
        status: 1,
        stdout: '',
        stderr: 'npm error code E401\nnpm error 401 Unauthorized',
      }),
    }),
    /Cannot publish Holo packages because npm authentication failed\.[\s\S]*npm login[\s\S]*E401/,
  )
})


test('publishing resolves workspace ranges and restores original manifests', async () => {
  const original = '{"name":"@holo-js/example","devDependencies":{"@holo-js/core":"workspace:*"}}\n'
  const repoRoot = await createTempRepo({
    'package.json': ['{"workspaces":{"catalog":{"@holo-js/core":"^0.3.16"}}}'],
    'packages/core/package.json': ['{"name":"@holo-js/core","version":"0.3.16"}'],
    'packages/example/package.json': original.split('\n'),
  })
  await withResolvedCatalogManifests(async () => {
    const manifest = JSON.parse(await readFile(join(repoRoot, 'packages/example/package.json'), 'utf8'))
    assert.equal(manifest.devDependencies['@holo-js/core'], '^0.3.16')
  }, repoRoot)
  assert.equal(await readFile(join(repoRoot, 'packages/example/package.json'), 'utf8'), original)
})


test('published manifests expose only built files, never workspace source entries', async () => {
  const original = `${JSON.stringify({
    name: '@holo-js/example',
    exports: {
      '.': { '@holo-js/source': './src/index.ts', types: './dist/index.d.ts', import: './dist/index.mjs' },
      './runtime': { '@holo-js/source': './src/runtime.ts', import: './dist/runtime.mjs' },
      './context': {
        types: './dist/context.d.ts',
        node: { '@holo-js/source': './src/context.node.ts', default: './dist/context.node.mjs' },
        default: { '@holo-js/source': './src/context.ts', default: './dist/context.mjs' },
      },
      './styles.css': './dist/styles.css',
    },
  })}\n`
  const repoRoot = await createTempRepo({
    'package.json': ['{"workspaces":{"catalog":{}}}'],
    'packages/example/package.json': original.split('\n'),
  })
  await withResolvedCatalogManifests(async () => {
    const manifest = JSON.parse(await readFile(join(repoRoot, 'packages/example/package.json'), 'utf8'))
    assert.deepEqual(manifest.exports, {
      '.': { types: './dist/index.d.ts', import: './dist/index.mjs' },
      './runtime': { import: './dist/runtime.mjs' },
      './context': { types: './dist/context.d.ts', node: './dist/context.node.mjs', default: './dist/context.mjs' },
      './styles.css': './dist/styles.css',
    })
  }, repoRoot)
  assert.equal(await readFile(join(repoRoot, 'packages/example/package.json'), 'utf8'), original)
})

test('publishing restores every source manifest when preparation fails partway', async () => {
  const core = '{ "name": "@holo-js/core", "version": "0.3.16", "dependencies": { "external": "catalog:" } }\n'
  const consumer = '{ "name": "@holo-js/consumer", "dependencies": { "missing": "catalog:" } }\n'
  const root = await createTempRepo({
    'package.json': ['{"workspaces":{"catalog":{"external":"^1.0.0"}}}'],
    'packages/a-core/package.json': core.split('\n'),
    'packages/z-consumer/package.json': consumer.split('\n'),
  })
  await assert.rejects(withResolvedCatalogManifests(() => {
    assert.fail('Publishing must not begin with unresolved dependencies')
  }, root), /Cannot resolve catalog range/)
  assert.equal(await readFile(join(root, 'packages/a-core/package.json'), 'utf8'), core)
  assert.equal(await readFile(join(root, 'packages/z-consumer/package.json'), 'utf8'), consumer)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`catalog resolver restores package manifests when publishing receives ${signal}`, async () => {
    const originalManifest = '{ "name": "@holo-js/example", "dependencies": { "@holo-js/core": "catalog:" } }\n'
    const repoRoot = await createTempRepo({
      'package.json': ['{"workspaces":{"catalog":{"@holo-js/core":"^0.3.28"}}}'],
      'packages/example/package.json': originalManifest.split('\n'),
    })
    const modulePath = fileURLToPath(new URL('./publish-with-resolved-catalogs.mjs', import.meta.url))
    const child = spawn(process.execPath, ['--input-type=module', '--eval', [
      `import { withResolvedCatalogManifests } from ${JSON.stringify(modulePath)}`,
      `await withResolvedCatalogManifests(async () => {`,
      `  process.stdout.write('published\\n')`,
      `  await new Promise(() => setInterval(() => {}, 1000))`,
      `}, ${JSON.stringify(repoRoot)})`,
    ].join('\n')], { stdio: ['ignore', 'pipe', 'pipe'] })

    await new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('published')) resolve()
      })
      child.once('exit', code => reject(new Error(`publish child exited early with code ${code}`)))
    })
    assert.match(await readFile(join(repoRoot, 'packages/example/package.json'), 'utf8'), /"@holo-js\/core": "\^0\.3\.28"/)

    child.kill(signal)
    await once(child, 'exit')

    assert.equal(await readFile(join(repoRoot, 'packages/example/package.json'), 'utf8'), originalManifest)
  })
}
