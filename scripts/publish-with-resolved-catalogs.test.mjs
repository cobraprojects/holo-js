import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import {
  resolveCatalogRangesInManifest,
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
