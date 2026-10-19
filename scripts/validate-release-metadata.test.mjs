import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, test } from 'node:test'
import { collectReleaseMetadataFailures } from './validate-release-metadata.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tempRoots = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, {
    recursive: true,
    force: true,
  })))
})

const validReleaseWorkflow = [
  'name: Release',
  'permissions:',
  '  contents: write',
  '  id-token: write',
  'jobs:',
  '  publish:',
  '    steps:',
  '      - run: bun run release',
  '        env:',
  "          NPM_CONFIG_PROVENANCE: 'true'",
  '      - run: git push origin --tags',
  '',
].join('\n')

function packageManifest(directory, overrides = {}) {
  return {
    name: `@holo-js/${directory}`,
    version: '0.3.28',
    license: 'MIT',
    repository: {
      type: 'git',
      url: 'git+https://github.com/cobraprojects/holo-js.git',
      directory: `packages/${directory}`,
    },
    files: ['dist', 'LICENSE'],
    ...overrides,
  }
}

async function createTempRepo(files) {
  const root = await mkdtemp(join(tmpdir(), 'holo-release-metadata-'))
  tempRoots.push(root)

  for (const [filePath, contents] of Object.entries(files)) {
    if (contents === undefined) continue
    const targetPath = join(root, filePath)
    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(targetPath, typeof contents === 'string' ? contents : `${JSON.stringify(contents, null, 2)}\n`, 'utf8')
  }

  return root
}

function completeRepo(overrides = {}) {
  return {
    'LICENSE': 'MIT License\n',
    'SECURITY.md': '# Security Policy\n',
    '.github/workflows/release.yml': validReleaseWorkflow,
    'packages/example/package.json': packageManifest('example'),
    'packages/example/LICENSE': 'MIT License\n',
    ...overrides,
  }
}

test('release metadata passes for a repository with license, security policy, repository fields, and provenance publishing', async () => {
  const root = await createTempRepo(completeRepo())

  assert.deepEqual(await collectReleaseMetadataFailures(root), [])
})

test('release metadata requires a root license and a security policy', async () => {
  const root = await createTempRepo(completeRepo({
    'LICENSE': undefined,
    'SECURITY.md': undefined,
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [
    'LICENSE is missing at the repository root.',
    'SECURITY.md is missing at the repository root.',
  ])
})

test('release metadata requires every published package to ship a license file', async () => {
  const root = await createTempRepo(completeRepo({
    'packages/example/LICENSE': undefined,
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [
    'packages/example/LICENSE is missing; every published package ships the license.',
  ])
})

test('release metadata requires every published package to list the license in its files', async () => {
  const root = await createTempRepo(completeRepo({
    'packages/example/package.json': packageManifest('example', { files: ['dist'] }),
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [
    'packages/example/package.json files must include "LICENSE".',
  ])
})

test('release metadata requires repository metadata that points at the package directory', async () => {
  const root = await createTempRepo(completeRepo({
    'packages/example/package.json': packageManifest('example', {
      repository: { type: 'git', url: 'https://github.com/cobraprojects/holo-js.git' },
    }),
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [
    'packages/example/package.json repository.directory must be "packages/example".',
  ])
})

test('release metadata rejects a repository url that is not the Holo repository', async () => {
  const root = await createTempRepo(completeRepo({
    'packages/example/package.json': packageManifest('example', {
      repository: {
        type: 'git',
        url: 'git+https://github.com/someone-else/holo-js.git',
        directory: 'packages/example',
      },
    }),
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [
    'packages/example/package.json repository.url must be "git+https://github.com/cobraprojects/holo-js.git".',
  ])
})

test('release metadata skips private packages', async () => {
  const root = await createTempRepo(completeRepo({
    'packages/internal/package.json': { name: 'internal', private: true },
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [])
})

test('release metadata requires the release workflow to publish with npm provenance', async () => {
  const root = await createTempRepo(completeRepo({
    '.github/workflows/release.yml': validReleaseWorkflow.replace(`          NPM_CONFIG_PROVENANCE: 'true'
`, ''),
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [
    `.github/workflows/release.yml must set NPM_CONFIG_PROVENANCE to 'true' so npm publishes with provenance.`,
  ])
})

test('release metadata requires the release workflow to grant OIDC identity for provenance', async () => {
  const root = await createTempRepo(completeRepo({
    '.github/workflows/release.yml': validReleaseWorkflow.replace('  id-token: write\n', ''),
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [
    '.github/workflows/release.yml must grant id-token: write so npm can attest provenance.',
  ])
})

test('release metadata requires the release workflow to push the release tags that publishing creates', async () => {
  const root = await createTempRepo(completeRepo({
    '.github/workflows/release.yml': validReleaseWorkflow.replace('git push origin --tags', 'true'),
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [
    '.github/workflows/release.yml must push the tags that changeset publish creates with `git push origin --tags`.',
  ])
})

test('release metadata requires the release workflow to run the guarded release script', async () => {
  const root = await createTempRepo(completeRepo({
    '.github/workflows/release.yml': validReleaseWorkflow.replace('bun run release', 'npx changeset publish'),
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [
    '.github/workflows/release.yml must publish with `bun run release`, which restores package manifests.',
  ])
})

test('release metadata holds for the Holo repository itself', async () => {
  assert.deepEqual(await collectReleaseMetadataFailures(repoRoot), [])
})
