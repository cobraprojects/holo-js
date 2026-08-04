import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import { promisify } from 'node:util'
import {
  collectCatalogPackageCoverageFailures,
  collectPackageManifestFailures,
  collectRootManifestFailures,
  collectScaffoldSourceFailures,
} from './validate-dependency-version-policy.mjs'

const execFileAsync = promisify(execFile)
const tempRoots = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(repoRoot => rm(repoRoot, {
    recursive: true,
    force: true,
  })))
})

async function createTestScaffold(files) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'holo-dependency-policy-'))
  tempRoots.push(repoRoot)
  await mkdir(join(repoRoot, 'packages/cli/src/project/scaffold'), { recursive: true })
  await mkdir(join(repoRoot, 'packages/cli/src'), { recursive: true })

  for (const [filePath, contents] of Object.entries(files)) {
    const targetPath = join(repoRoot, filePath)
    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(targetPath, contents.join('\n'), 'utf8')
  }

  return repoRoot
}

async function trackTestFiles(repoRoot) {
  await execFileAsync('git', ['init'], { cwd: repoRoot })
  await execFileAsync('git', ['add', '.'], { cwd: repoRoot })
}

const frameworkSource = [
  'import { SCAFFOLD_BASE_DEV_DEPENDENCY_VERSIONS } from \'../../metadata\'',
  '',
  'export function renderScaffoldPackageJson() {',
  '  const devDependencies = {',
  '    eslint: SCAFFOLD_BASE_DEV_DEPENDENCY_VERSIONS.eslint,',
  '  }',
  '  return JSON.stringify({ devDependencies })',
  '}',
  '',
  'export async function scaffoldProject() {}',
  '',
]

test('dependency policy validator catches forbidden scaffold ranges from imported constants', async () => {
  const repoRoot = await createTestScaffold({
    'packages/cli/src/metadata.ts': [
      'export const SCAFFOLD_BASE_DEV_DEPENDENCY_VERSIONS = Object.freeze({',
      '  eslint: \'catalog:\',',
      '} as const)',
      '',
    ],
    'packages/cli/src/project/scaffold/framework.ts': frameworkSource,
  })

  const failures = await collectScaffoldSourceFailures(repoRoot)

  assert.equal(failures.length, 1)
  assert.match(failures[0], /catalog:/)
  assert.match(failures[0], /SCAFFOLD_BASE_DEV_DEPENDENCY_VERSIONS/)
})

test('dependency policy validator follows default imports through arrow helpers', async () => {
  const repoRoot = await createTestScaffold({
    'packages/cli/src/metadata.ts': [
      'import baseVersions from \'./versions\'',
      '',
      'const buildVersions = () => ({',
      '  eslint: baseVersions.eslint,',
      '})',
      '',
      'export const SCAFFOLD_BASE_DEV_DEPENDENCY_VERSIONS = buildVersions()',
      '',
    ],
    'packages/cli/src/versions.ts': [
      'export default Object.freeze({',
      '  eslint: \'catalog:\',',
      '} as const)',
      '',
    ],
    'packages/cli/src/project/scaffold/framework.ts': frameworkSource,
  })

  const failures = await collectScaffoldSourceFailures(repoRoot)

  assert.equal(failures.length, 1)
  assert.match(failures[0], /catalog:/)
  assert.match(failures[0], /default/)
})

test('dependency policy validator follows namespace imports through function expressions', async () => {
  const repoRoot = await createTestScaffold({
    'packages/cli/src/metadata.ts': [
      'import * as versions from \'./versions\'',
      '',
      'const buildVersions = function () {',
      '  return {',
      '    eslint: versions.baseVersions.eslint,',
      '  }',
      '}',
      '',
      'export const SCAFFOLD_BASE_DEV_DEPENDENCY_VERSIONS = buildVersions()',
      '',
    ],
    'packages/cli/src/versions.ts': [
      'export const baseVersions = Object.freeze({',
      '  eslint: \'catalog:\',',
      '} as const)',
      '',
    ],
    'packages/cli/src/project/scaffold/framework.ts': frameworkSource,
  })

  const failures = await collectScaffoldSourceFailures(repoRoot)

  assert.equal(failures.length, 1)
  assert.match(failures[0], /catalog:/)
  assert.match(failures[0], /baseVersions/)
})

test('dependency policy validator allows valid semver ranges', async () => {
  const repoRoot = await createTestScaffold({
    'packages/cli/src/metadata.ts': [
      'export const SCAFFOLD_BASE_DEV_DEPENDENCY_VERSIONS = Object.freeze({',
      '  eslint: \'^8.0.0\',',
      '} as const)',
      '',
    ],
    'packages/cli/src/project/scaffold/framework.ts': frameworkSource,
  })

  const failures = await collectScaffoldSourceFailures(repoRoot)

  assert.equal(failures.length, 0)
})

test('dependency policy validator requires package manifests to use catalog ranges', async () => {
  const repoRoot = await createTestScaffold({
    'packages/example/package.json': [
      '{',
      '  "name": "@holo-js/example",',
      '  "version": "0.1.4",',
      '  "dependencies": {',
      '    "@holo-js/core": "^0.1.4",',
      '    "typescript": "catalog:"',
      '  }',
      '}',
      '',
    ],
  })

  const failures = await collectPackageManifestFailures(repoRoot)

  assert.equal(failures.length, 1)
  assert.match(failures[0], /@holo-js\/core/)
  assert.match(failures[0], /catalog:/)
})

test('dependency policy validator ignores nested fixture manifests', async () => {
  const repoRoot = await createTestScaffold({
    'packages/example/package.json': [
      '{',
      '  "name": "@holo-js/example",',
      '  "version": "0.1.4",',
      '  "dependencies": {',
      '    "typescript": "catalog:"',
      '  }',
      '}',
      '',
    ],
    'packages/example/tests/fixtures/project/package.json': [
      '{',
      '  "name": "fixture-project",',
      '  "version": "1.0.0",',
      '  "dependencies": {',
      '    "typescript": "^5.9.3"',
      '  }',
      '}',
      '',
    ],
  })
  await trackTestFiles(repoRoot)

  const failures = await collectPackageManifestFailures(repoRoot)

  assert.deepEqual(failures, [])
})

test('dependency policy validator requires root catalog dependencies to use catalog ranges', async () => {
  const repoRoot = await createTestScaffold({
    'package.json': [
      '{',
      '  "workspaces": {',
      '    "catalog": {',
      '      "react": "^19.2.6"',
      '    }',
      '  },',
      '  "dependencies": {',
      '    "react": "^19.2.6"',
      '  }',
      '}',
      '',
    ],
  })

  const failures = await collectRootManifestFailures(repoRoot)

  assert.equal(failures.length, 1)
  assert.match(failures[0], /dependencies\.react/)
  assert.match(failures[0], /catalog:/)
})

test('dependency policy validator requires the catalog to include every package', async () => {
  const repoRoot = await createTestScaffold({
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
    'packages/example/package.json': [
      '{',
      '  "name": "@holo-js/example",',
      '  "version": "0.1.4",',
      '  "dependencies": {',
      '    "@holo-js/core": "catalog:"',
      '  }',
      '}',
      '',
    ],
  })

  const failures = await collectCatalogPackageCoverageFailures(repoRoot)

  assert.equal(failures.length, 1)
  assert.match(failures[0], /@holo-js\/example/)
})
