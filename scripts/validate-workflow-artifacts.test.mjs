import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, test } from 'node:test'
import { collectWorkflowArtifactFailures } from './validate-workflow-artifacts.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tempRoots = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, {
    recursive: true,
    force: true,
  })))
})

async function createTempRepo(workflows) {
  const root = await mkdtemp(join(tmpdir(), 'holo-workflow-artifacts-'))
  tempRoots.push(root)

  for (const [name, contents] of Object.entries(workflows)) {
    const targetPath = join(root, '.github/workflows', name)
    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(targetPath, contents, 'utf8')
  }

  return root
}

function workflow(...steps) {
  return [
    'name: CI',
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: bun run test',
    ...steps.flat(),
    '',
  ].join('\n')
}

const diagnosticUpload = [
  '      - id: upload-logs',
  '        uses: actions/upload-artifact@v7',
  '        if: always()',
  '        continue-on-error: true',
  '        with:',
  '          name: test-logs',
  '          path: coverage/',
]

const uploadWarning = [
  `      - if: always() && steps.upload-logs.outcome == 'failure'`,
  `        run: echo "::warning title=Diagnostic upload failed::test-logs could not be uploaded."`,
]

const consumedUpload = [
  '      - uses: actions/upload-artifact@v7',
  '        with:',
  '          name: build-output',
  '          path: dist/',
]

const consumer = [
  '  deploy:',
  '    needs: test',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/download-artifact@v7',
  '        with:',
  '          name: build-output',
]

test('workflow artifacts pass when a diagnostic upload continues on error and warns on failure', async () => {
  const root = await createTempRepo({ 'ci.yml': workflow(diagnosticUpload, uploadWarning) })

  assert.deepEqual(await collectWorkflowArtifactFailures(root), [])
})

test('workflow artifacts reject a diagnostic upload that can fail its job', async () => {
  const root = await createTempRepo({
    'ci.yml': workflow(diagnosticUpload.filter(line => !line.includes('continue-on-error')), uploadWarning),
  })

  assert.deepEqual(await collectWorkflowArtifactFailures(root), [
    '.github/workflows/ci.yml uploads the diagnostic artifact test-logs, which no job downloads, so its step must set continue-on-error: true.',
  ])
})

test('workflow artifacts require a warning annotation when a diagnostic upload fails', async () => {
  const root = await createTempRepo({ 'ci.yml': workflow(diagnosticUpload) })

  assert.deepEqual(await collectWorkflowArtifactFailures(root), [
    `.github/workflows/ci.yml must follow the diagnostic artifact test-logs upload with a step that runs on \`always() && steps.upload-logs.outcome == 'failure'\` and emits a ::warning annotation.`,
  ])
})

test('workflow artifacts require the warning to run even after an earlier step failed', async () => {
  const root = await createTempRepo({
    'ci.yml': workflow(diagnosticUpload, uploadWarning.map(line => line.replace('always() && ', ''))),
  })

  assert.equal((await collectWorkflowArtifactFailures(root)).length, 1)
})

test('workflow artifacts require a diagnostic upload to have an id the warning can read', async () => {
  const root = await createTempRepo({
    'ci.yml': workflow(diagnosticUpload.map(line => line.replace('- id: upload-logs', '- name: Upload logs')), uploadWarning),
  })

  assert.equal((await collectWorkflowArtifactFailures(root)).length, 1)
})

test('workflow artifacts keep an upload that a later job downloads fatal', async () => {
  const root = await createTempRepo({ 'ci.yml': workflow(consumedUpload, consumer) })

  assert.deepEqual(await collectWorkflowArtifactFailures(root), [])
})

test('workflow artifacts reject continue-on-error on an upload that a later job downloads', async () => {
  const root = await createTempRepo({
    'ci.yml': workflow(consumedUpload.toSpliced(1, 0, '        continue-on-error: true'), consumer),
  })

  assert.deepEqual(await collectWorkflowArtifactFailures(root), [
    '.github/workflows/ci.yml uploads build-output, which a job downloads, so its step must not set continue-on-error.',
  ])
})

test('workflow artifacts treat a download without a name or with a matching pattern as consuming the upload', async () => {
  const continuing = consumedUpload.toSpliced(1, 0, '        continue-on-error: true')
  const unnamed = await createTempRepo({
    'ci.yml': workflow(continuing, consumer.slice(0, -2)),
  })
  const patterned = await createTempRepo({
    'ci.yml': workflow(continuing),
    'deploy.yml': workflow(consumer.slice(4, -1), '          pattern: build-*'),
  })

  assert.equal((await collectWorkflowArtifactFailures(unnamed)).length, 1)
  assert.equal((await collectWorkflowArtifactFailures(patterned)).length, 1)
})

test('workflow artifacts hold for the Holo repository itself', async () => {
  assert.deepEqual(await collectWorkflowArtifactFailures(repoRoot), [])
})
