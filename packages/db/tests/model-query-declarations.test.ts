import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import ts from 'typescript'
import { expect, it } from 'vitest'
import { resolveInstalledDependencyRoot, stagePublishedPackage, symlinkPackageDependency } from '../../../tests/support/published-package'

const run = promisify(execFile)
const packageDir = resolve(import.meta.dirname, '..')
const repoRoot = resolve(packageDir, '../..')

it('emits declarations for a consumer of the built DB package', async () => {
  const consumerDir = await mkdtemp(join(tmpdir(), 'holo-db-declarations-'))

  try {
    const distDir = join(consumerDir, 'build')
    const nodeModules = join(consumerDir, 'node_modules')
    await run('bun', ['run', 'build'], {
      cwd: packageDir,
      env: { ...process.env, HOLO_BUILD_OUT_DIR: distDir },
      timeout: 45_000,
    })
    await stagePublishedPackage(packageDir, join(nodeModules, '@holo-js/db'), distDir)
    await symlinkPackageDependency(nodeModules, 'vitest', resolveInstalledDependencyRoot(repoRoot, 'vitest'))

    const fixturePath = join(consumerDir, 'model-query-declarations.mts')
    await copyFile(join(import.meta.dirname, 'fixtures/model-query-declarations.ts'), fixturePath)
    const program = ts.createProgram([fixturePath], {
      declaration: true,
      emitDeclarationOnly: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmitOnError: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      types: [],
    })
    let declaration = ''
    const { diagnostics } = program.emit(undefined, (_file, contents) => { declaration = contents })
    expect(diagnostics.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n')).toBe('')
    expect(declaration).toContain('export declare function findPost')
    expect(declaration).toContain('export declare function findTopic')
  } finally {
    await rm(consumerDir, { recursive: true, force: true })
  }
}, 60_000)
