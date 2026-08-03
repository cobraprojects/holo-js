import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stagePublishedPackage } from '../../../tests/support/published-package'

const packageRoot = resolve(import.meta.dirname, '..')

function run(command: string, args: readonly string[], cwd: string): string {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    })
  } catch (error) {
    const failure = error as { stdout?: Buffer, stderr?: Buffer }
    throw new Error([
      failure.stdout?.toString(),
      failure.stderr?.toString(),
    ].filter(Boolean).join('\n'))
  }
}

describe('@holo-js/kernel published package', () => {
  it('publishes the complete project preparation runtime and type surface', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'holo-kernel-published-'))
    const buildRoot = join(temporaryRoot, 'build')
    const applicationRoot = join(temporaryRoot, 'application')
    const packageTarget = join(applicationRoot, 'node_modules/@holo-js/kernel')

    try {
      execFileSync('bun', ['run', 'build'], {
        cwd: packageRoot,
        env: {
          ...process.env,
          HOLO_BUILD_OUT_DIR: buildRoot,
        },
        stdio: 'pipe',
      })
      await mkdir(applicationRoot, { recursive: true })
      await stagePublishedPackage(packageRoot, packageTarget, buildRoot)
      await writeFile(join(applicationRoot, 'runtime.mjs'), `import {
  HOLO_PROJECT_PREPARE_API_VERSION,
  HoloProjectPrepareError,
  defineHoloProjectPreparer,
} from '@holo-js/kernel'

const preparer = defineHoloProjectPreparer({
  apiVersion: HOLO_PROJECT_PREPARE_API_VERSION,
  prepare() {
    return { kind: 'prepared' }
  },
})
const result = await preparer.prepare()
const failure = new HoloProjectPrepareError({
  code: 'SMOKE_FAILURE',
  message: 'Safe smoke failure.',
})

if (!Object.isFrozen(preparer) || result.kind !== 'prepared' || failure.failure.code !== 'SMOKE_FAILURE') {
  throw new Error('Published project preparation runtime is invalid.')
}

process.stdout.write(String(HOLO_PROJECT_PREPARE_API_VERSION))
`)
      expect(run('node', ['runtime.mjs'], applicationRoot)).toBe('1')

      await writeFile(join(applicationRoot, 'types.ts'), `import {
  HOLO_PROJECT_PREPARE_API_VERSION,
  HoloProjectPrepareError,
  defineHoloProjectPreparer,
  normalizeHoloProjectConfig,
  type HoloGeneratedProjectArtifact,
  type HoloManagedProjectArtifact,
  type HoloPluginProjectContributions,
  type HoloProjectArtifactContents,
  type HoloProjectPrepareChange,
  type HoloProjectPrepareChangeKind,
  type HoloProjectPrepareCommand,
  type HoloProjectPrepareContext,
  type HoloProjectPrepareDiagnostic,
  type HoloProjectPrepareFailure,
  type HoloProjectPrepareFramework,
  type HoloProjectPrepareFullRetry,
  type HoloProjectPrepareLogger,
  type HoloProjectPrepareModule,
  type HoloProjectPreparePlugin,
  type HoloProjectPrepareResult,
  type HoloProjectPrepareRun,
  type HoloProjectPrepareSource,
  type HoloProjectPrepareWatch,
  type HoloProjectPreparedResult,
  type HoloProjectPreparer,
} from '@holo-js/kernel'

const command: HoloProjectPrepareCommand = 'prepare'
const changeKind: HoloProjectPrepareChangeKind = 'changed'
const change: HoloProjectPrepareChange = { path: 'server/audit.ts', kind: changeKind }
const run: HoloProjectPrepareRun = { kind: 'incremental', command: 'dev', changes: [change] }
const framework: HoloProjectPrepareFramework = {
  id: 'next',
  displayName: 'Next.js',
  adapterPackage: '@holo-js/adapter-next',
  capabilities: { managedBroadcastAuthRoute: true },
}
const plugin: HoloProjectPreparePlugin = {
  id: 'audit',
  packageName: 'holo-audit',
  packageRoot: '/application/node_modules/holo-audit',
}
const logger: HoloProjectPrepareLogger = { info() {}, warn() {} }
const context: HoloProjectPrepareContext = {
  projectRoot: '/application',
  generatedRoot: '/application/.holo-js/generated',
  pluginGeneratedRoot: '/application/.holo-js/generated/audit',
  config: normalizeHoloProjectConfig(),
  framework,
  plugin,
  run,
  signal: new AbortController().signal,
  logger,
}
const contents: HoloProjectArtifactContents = new Uint8Array([1])
const generated: HoloGeneratedProjectArtifact = { path: 'registry.json', contents }
const managed: HoloManagedProjectArtifact = { path: 'app/api/audit/route.ts', contents: 'route' }
const watch: HoloProjectPrepareWatch = { roots: ['server/audit'], excludes: ['server/audit/generated'] }
const source: HoloProjectPrepareSource = { path: 'server/audit.ts', line: 1, column: 1 }
const diagnostic: HoloProjectPrepareDiagnostic = {
  severity: 'warning',
  code: 'AUDIT_WARNING',
  message: 'Review audit configuration.',
  source,
}
const failure: HoloProjectPrepareFailure = { code: 'AUDIT_FAILURE', message: 'Audit failed.', source }
const prepared: HoloProjectPreparedResult = {
  kind: 'prepared',
  generatedArtifacts: [generated],
  managedArtifacts: [managed],
  watch,
  diagnostics: [diagnostic],
}
const retry: HoloProjectPrepareFullRetry = { kind: 'retry-full', reason: 'Refresh graph.' }
const result: HoloProjectPrepareResult = prepared
const preparer: HoloProjectPreparer = defineHoloProjectPreparer({
  apiVersion: HOLO_PROJECT_PREPARE_API_VERSION,
  prepare: () => result,
})
const moduleValue: HoloProjectPrepareModule = { preparer }
const contribution: HoloPluginProjectContributions = { prepare: './prepare.mjs' }
const error = new HoloProjectPrepareError(failure)

void command
void context
void retry
void moduleValue
void contribution
void error
`)
      await writeFile(join(applicationRoot, 'tsconfig.json'), `${JSON.stringify({
        compilerOptions: {
          lib: ['ES2022', 'DOM'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          strict: true,
          target: 'ES2022',
        },
        files: ['types.ts'],
      }, null, 2)}\n`)
      run(resolve(packageRoot, '../../node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], applicationRoot)
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  }, 60_000)
})
