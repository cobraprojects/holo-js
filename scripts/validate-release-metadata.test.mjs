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

const buildOrderFailure = '.github/workflows/release.yml must build packages with `node scripts/build-libraries.mjs` in an unconditional step without continue-on-error, before the publish step, so declarations resolve in dependency order.'
const sharedJobFailure = '.github/workflows/release.yml must build and publish in one job, because the built packages must reach the publish step on the same filesystem.'
const tokenFailure = '.github/workflows/release.yml must fail when NPM_TOKEN is not configured and a package version is not on npm yet, and skip with a notice only when every version is already published.'
const ciGateFailure = '.github/workflows/release.yml must wait for CI on this commit with `node scripts/wait-for-release-ci.mjs` in its own job before publishing.'

const rejectOtherRefsRun = 'test "$GITHUB_REF" = refs/heads/main || { echo "::error::Releases publish only from main."; exit 1; }'

const validReleaseWorkflow = [
  'name: Release',
  'permissions:',
  '  contents: write',
  '  id-token: write',
  'jobs:',
  '  ci:',
  `    if: github.ref == 'refs/heads/main'`,
  '    permissions:',
  '      actions: read',
  '      contents: read',
  '    steps:',
  '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
  '        with:',
  '          ref: ${{ github.sha }}',
  '      - name: Require every CI workflow to pass for this commit',
  '        env:',
  '          GITHUB_TOKEN: ${{ github.token }}',
  '        run: node scripts/wait-for-release-ci.mjs',
  '  publish:',
  '    needs: ci',
  `    if: github.ref == 'refs/heads/main'`,
  '    environment: release',
  '    steps:',
  '      - name: Reject runs from other refs',
  `        run: ${rejectOtherRefsRun}`,
  '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
  '        with:',
  '          ref: ${{ github.sha }}',
  '      - run: node scripts/build-libraries.mjs',
  '      - run: git config user.name "github-actions[bot]"',
  '      - run: git config user.email "41898282+github-actions[bot]@users.noreply.github.com"',
  '      - name: Publish changed packages with npm provenance',
  '        env:',
  '          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}',
  `          NPM_CONFIG_PROVENANCE: 'true'`,
  '        run: |',
  '          if [ -z "$NODE_AUTH_TOKEN" ]; then',
  '            unpublished="$(node scripts/list-unpublished-packages.mjs)"',
  '            if [ -n "$unpublished" ]; then',
  '              echo "::error title=NPM_TOKEN is missing::A publish is due, but NPM_TOKEN is not configured."',
  '              echo "$unpublished"',
  '              exit 1',
  '            fi',
  '            echo "::notice title=Release skipped::NPM_TOKEN is not configured, and every package version is already on npm."',
  '            exit 0',
  '          fi',
  '          bun run release:skip-build',
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

test('release metadata requires the release workflow to configure a git identity for the release tags', async () => {
  const root = await createTempRepo(completeRepo({
    '.github/workflows/release.yml': validReleaseWorkflow.replace('git config user.name "github-actions[bot]"', 'true'),
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [
    '.github/workflows/release.yml must set git user.name and user.email before publishing, because changeset publish creates annotated tags.',
  ])
})

test('release metadata requires the release workflow to run the guarded release script', async () => {
  const root = await createTempRepo(completeRepo({
    '.github/workflows/release.yml': validReleaseWorkflow.replace('bun run release', 'npx changeset publish'),
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [
    '.github/workflows/release.yml must give NPM_TOKEN only to the publish step.',
    '.github/workflows/release.yml must publish with `bun run release`, which restores package manifests.',
  ])
})

test('release metadata gives NPM_TOKEN only to the publish step', async () => {
  const root = await createTempRepo(completeRepo({
    '.github/workflows/release.yml': validReleaseWorkflow.replace(
      '      - run: node scripts/build-libraries.mjs',
      '      - run: node scripts/build-libraries.mjs\n        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}',
    ),
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [
    '.github/workflows/release.yml must give NPM_TOKEN only to the publish step.',
  ])
})

test('release metadata rejects the root build as the release build step', async () => {
  const root = await createTempRepo(completeRepo({
    '.github/workflows/release.yml': validReleaseWorkflow.replace('node scripts/build-libraries.mjs', 'bun run build'),
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [
    buildOrderFailure,
  ])
})

test('release metadata runs the dependency-ordered build unconditionally', async () => {
  const root = await createTempRepo(completeRepo({
    '.github/workflows/release.yml': validReleaseWorkflow.replace(
      '      - run: node scripts/build-libraries.mjs',
      '      - if: false\n        run: node scripts/build-libraries.mjs',
    ),
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [
    buildOrderFailure,
  ])
})

test('release metadata runs the dependency-ordered build before publishing', async () => {
  const root = await createTempRepo(completeRepo({
    '.github/workflows/release.yml': validReleaseWorkflow
      .replace('      - run: node scripts/build-libraries.mjs\n', '')
      .replace('      - run: git push origin --tags\n', '      - run: git push origin --tags\n      - run: node scripts/build-libraries.mjs\n'),
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [
    buildOrderFailure,
  ])
})

test('release metadata rejects a dependency-ordered build that can fail without failing the release', async () => {
  const root = await createTempRepo(completeRepo({
    '.github/workflows/release.yml': validReleaseWorkflow.replace(
      '      - run: node scripts/build-libraries.mjs',
      '      - continue-on-error: true\n        run: node scripts/build-libraries.mjs',
    ),
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [
    buildOrderFailure,
  ])
})

test('release metadata requires the build and the publish to share one job', async () => {
  const root = await createTempRepo(completeRepo({
    '.github/workflows/release.yml': validReleaseWorkflow
      .replace('  publish:\n', '  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node scripts/build-libraries.mjs\n  publish:\n')
      .replace('      - run: node scripts/build-libraries.mjs\n      - run: git config user.name', '      - run: git config user.name'),
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [
    sharedJobFailure,
  ])
})

test('release metadata rejects a spaced step key that disables the build', async () => {
  const root = await createTempRepo(completeRepo({
    '.github/workflows/release.yml': validReleaseWorkflow.replace(
      '      - run: node scripts/build-libraries.mjs',
      '      - if : false\n        run: node scripts/build-libraries.mjs',
    ),
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [buildOrderFailure])
})

test('release metadata counts quoted job keys when requiring one job', async () => {
  const root = await createTempRepo(completeRepo({
    '.github/workflows/release.yml': validReleaseWorkflow
      .replace('  publish:\n', '  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node scripts/build-libraries.mjs\n  "publish-again":\n')
      .replace('      - run: node scripts/build-libraries.mjs\n      - run: git config user.name', '      - run: git config user.name'),
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [sharedJobFailure])
})

test('release metadata counts job headers that carry a trailing comment', async () => {
  const root = await createTempRepo(completeRepo({
    '.github/workflows/release.yml': validReleaseWorkflow
      .replace('  publish:\n', '  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node scripts/build-libraries.mjs\n  publish: # Publish packages\n')
      .replace('      - run: node scripts/build-libraries.mjs\n      - run: git config user.name', '      - run: git config user.name'),
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [sharedJobFailure])
})

test('release metadata requires the publish step to skip with a notice when every version is already on npm', async () => {
  const root = await createTempRepo(completeRepo({
    '.github/workflows/release.yml': validReleaseWorkflow.replace('::notice title=Release skipped::', 'Release skipped: '),
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [tokenFailure])
})

test('release metadata requires the publish step to fail when NPM_TOKEN is missing and a publish is due', async () => {
  const root = await createTempRepo(completeRepo({
    '.github/workflows/release.yml': validReleaseWorkflow.replace('unpublished="$(node scripts/list-unpublished-packages.mjs)"', 'unpublished=""'),
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [tokenFailure])
})

test('release metadata requires the publish job to wait for the CI gate with needs', async () => {
  const root = await createTempRepo(completeRepo({
    '.github/workflows/release.yml': validReleaseWorkflow.replace('    needs: ci\n', ''),
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [
    '.github/workflows/release.yml must make the publish job depend on the CI gate job `ci` with needs, so nothing publishes unless CI passed for this commit.',
  ])
})

test('release metadata requires a job that waits for CI on the commit before publishing', async () => {
  const root = await createTempRepo(completeRepo({
    '.github/workflows/release.yml': validReleaseWorkflow.replace('        run: node scripts/wait-for-release-ci.mjs', '        run: echo skipped'),
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [ciGateFailure])
})

test('release metadata checks out the triggering commit in the publish job, not only in the CI gate', async () => {
  const publishCheckout = validReleaseWorkflow.lastIndexOf('          ref: ${{ github.sha }}')
  const mutated = validReleaseWorkflow.slice(0, publishCheckout) + '          ref: main' + validReleaseWorkflow.slice(publishCheckout + '          ref: ${{ github.sha }}'.length)
  const root = await createTempRepo(completeRepo({
    '.github/workflows/release.yml': mutated,
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [
    '.github/workflows/release.yml must check out github.sha in the publish job, not a user-chosen ref.',
  ])
})

test('release metadata rejects a CI gate that continues on error, so failed CI could still publish', async () => {
  const root = await createTempRepo(completeRepo({
    '.github/workflows/release.yml': validReleaseWorkflow.replace(
      '        run: node scripts/wait-for-release-ci.mjs',
      '        continue-on-error: true\n        run: node scripts/wait-for-release-ci.mjs',
    ),
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [
    '.github/workflows/release.yml must let a failed CI run fail the CI gate job, so it may not use continue-on-error or a step-level if.',
  ])
})

test('release metadata requires the due-publish branch to exit non-zero when NPM_TOKEN is missing', async () => {
  const root = await createTempRepo(completeRepo({
    '.github/workflows/release.yml': validReleaseWorkflow.replace('              exit 1\n', '              exit 0\n'),
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [tokenFailure])
})

test('release metadata grants the CI gate job read access to workflow runs', async () => {
  const root = await createTempRepo(completeRepo({
    '.github/workflows/release.yml': validReleaseWorkflow.replace('      actions: read\n', ''),
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [
    '.github/workflows/release.yml must grant actions: read to the CI gate job so it can list workflow runs for this commit.',
  ])
})

test('release metadata runs the publish job only for refs/heads/main', async () => {
  const root = await createTempRepo(completeRepo({
    '.github/workflows/release.yml': validReleaseWorkflow.replaceAll("    if: github.ref == 'refs/heads/main'\n", ''),
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [
    '.github/workflows/release.yml must run the publish job only for refs/heads/main.',
  ])
})

test('release metadata rejects a run from another ref in an early step', async () => {
  const root = await createTempRepo(completeRepo({
    '.github/workflows/release.yml': validReleaseWorkflow.replace(`        run: ${rejectOtherRefsRun}`, '        run: echo ok'),
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [
    '.github/workflows/release.yml must reject runs from refs other than main in an early step.',
  ])
})

test('release metadata pins checkout to the triggering commit', async () => {
  const root = await createTempRepo(completeRepo({
    '.github/workflows/release.yml': validReleaseWorkflow.replaceAll('          ref: ${{ github.sha }}\n', ''),
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [
    '.github/workflows/release.yml must check out github.sha in the publish job, not a user-chosen ref.',
  ])
})

test('release metadata declares the release environment for the publish job', async () => {
  const root = await createTempRepo(completeRepo({
    '.github/workflows/release.yml': validReleaseWorkflow.replace('    environment: release\n', ''),
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [
    '.github/workflows/release.yml must declare environment: release so NPM_TOKEN sits behind its protection rules.',
  ])
})

test('release metadata requires every action in the release workflow to be pinned to a full commit SHA', async () => {
  const root = await createTempRepo(completeRepo({
    '.github/workflows/release.yml': validReleaseWorkflow.replace(
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
      'actions/checkout@v7',
    ),
  }))

  assert.deepEqual(await collectReleaseMetadataFailures(root), [
    '.github/workflows/release.yml must pin every action to a full 40-character commit SHA; unpinned: actions/checkout@v7.',
  ])
})

test('release metadata holds for the Holo repository itself', async () => {
  assert.deepEqual(await collectReleaseMetadataFailures(repoRoot), [])
})
