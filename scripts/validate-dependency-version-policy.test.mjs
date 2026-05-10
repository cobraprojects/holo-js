import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { collectScaffoldSourceFailures } from './validate-dependency-version-policy.mjs'

test('dependency policy validator catches forbidden scaffold ranges from imported constants', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'holo-dependency-policy-'))
  await mkdir(join(repoRoot, 'packages/cli/src/project/scaffold'), { recursive: true })
  await mkdir(join(repoRoot, 'packages/cli/src'), { recursive: true })
  await writeFile(join(repoRoot, 'packages/cli/src/metadata.ts'), [
    'export const SCAFFOLD_BASE_DEV_DEPENDENCY_VERSIONS = Object.freeze({',
    '  eslint: \'catalog:\',',
    '} as const)',
    '',
  ].join('\n'), 'utf8')
  await writeFile(join(repoRoot, 'packages/cli/src/project/scaffold/framework.ts'), [
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
  ].join('\n'), 'utf8')

  const failures = await collectScaffoldSourceFailures(repoRoot)

  assert.equal(failures.length, 1)
  assert.match(failures[0], /catalog:/)
  assert.match(failures[0], /SCAFFOLD_BASE_DEV_DEPENDENCY_VERSIONS/)
})

test('dependency policy validator follows default imports through arrow helpers', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'holo-dependency-policy-'))
  await mkdir(join(repoRoot, 'packages/cli/src/project/scaffold'), { recursive: true })
  await mkdir(join(repoRoot, 'packages/cli/src'), { recursive: true })
  await writeFile(join(repoRoot, 'packages/cli/src/metadata.ts'), [
    'import baseVersions from \'./versions\'',
    '',
    'const buildVersions = () => ({',
    '  eslint: baseVersions.eslint,',
    '})',
    '',
    'export const SCAFFOLD_BASE_DEV_DEPENDENCY_VERSIONS = buildVersions()',
    '',
  ].join('\n'), 'utf8')
  await writeFile(join(repoRoot, 'packages/cli/src/versions.ts'), [
    'export default Object.freeze({',
    '  eslint: \'catalog:\',',
    '} as const)',
    '',
  ].join('\n'), 'utf8')
  await writeFile(join(repoRoot, 'packages/cli/src/project/scaffold/framework.ts'), [
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
  ].join('\n'), 'utf8')

  const failures = await collectScaffoldSourceFailures(repoRoot)

  assert.equal(failures.length, 1)
  assert.match(failures[0], /catalog:/)
  assert.match(failures[0], /default/)
})

test('dependency policy validator follows namespace imports through function expressions', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'holo-dependency-policy-'))
  await mkdir(join(repoRoot, 'packages/cli/src/project/scaffold'), { recursive: true })
  await mkdir(join(repoRoot, 'packages/cli/src'), { recursive: true })
  await writeFile(join(repoRoot, 'packages/cli/src/metadata.ts'), [
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
  ].join('\n'), 'utf8')
  await writeFile(join(repoRoot, 'packages/cli/src/versions.ts'), [
    'export const baseVersions = Object.freeze({',
    '  eslint: \'catalog:\',',
    '} as const)',
    '',
  ].join('\n'), 'utf8')
  await writeFile(join(repoRoot, 'packages/cli/src/project/scaffold/framework.ts'), [
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
  ].join('\n'), 'utf8')

  const failures = await collectScaffoldSourceFailures(repoRoot)

  assert.equal(failures.length, 1)
  assert.match(failures[0], /catalog:/)
  assert.match(failures[0], /baseVersions/)
})
