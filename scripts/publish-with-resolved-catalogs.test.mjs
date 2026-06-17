import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import {
  resolveCatalogRangesInManifest,
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

test('catalog resolver replaces package dependency ranges from the root catalog', () => {
  const resolved = resolveCatalogRangesInManifest({
    dependencies: {
      '@holo-js/core': 'catalog:',
    },
    peerDependencies: {
      react: 'catalog:',
    },
  }, {
    '@holo-js/core': '^0.1.4',
    react: '^19.0.0',
  })

  assert.deepEqual(resolved.dependencies, {
    '@holo-js/core': '^0.1.4',
  })
  assert.deepEqual(resolved.peerDependencies, {
    react: '^19.0.0',
  })
})

test('catalog resolver rejects catalog dependencies missing from the root catalog', () => {
  assert.throws(
    () => resolveCatalogRangesInManifest({
      dependencies: {
        '@holo-js/newpkg': 'catalog:',
      },
    }, {
      '@holo-js/core': '^0.1.4',
    }),
    /Cannot resolve catalog range for dependencies\.@holo-js\/newpkg\./,
  )
})

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
