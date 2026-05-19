import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

type RunCliContext = {
  cwd: string
  stdin: typeof process.stdin
  stdout: typeof process.stdout
  stderr: typeof process.stderr
}

type RunCli = (args: string[], context: RunCliContext) => Promise<number>

const runCliMock = vi.hoisted(() => vi.fn<RunCli>())

vi.mock('@holo-js/cli', () => ({
  runCli: runCliMock,
}))

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageDir, '../..')
const tempBuildRoots: string[] = []
let packageBuildPromise: Promise<{ outDir: string }> | null = null
const originalArgv = process.argv
const originalExitCode = process.exitCode

async function createTempBuildRoot(): Promise<string> {
  const baseDir = resolve(repoRoot, '.vitest-builds')
  await mkdir(baseDir, { recursive: true })
  const root = await mkdtemp(join(baseDir, 'create-holo-js-'))
  tempBuildRoots.push(root)
  return root
}

async function runPackageBuild(): Promise<{ outDir: string }> {
  if (!packageBuildPromise) {
    packageBuildPromise = (async () => {
      const buildRoot = await createTempBuildRoot()
      const outDir = join(buildRoot, 'dist')

      execFileSync(resolve(packageDir, 'node_modules/.bin/tsup'), [], {
        cwd: packageDir,
        env: {
          ...process.env,
          HOLO_BUILD_OUT_DIR: outDir,
        },
        stdio: 'pipe',
      })

      const cliStubDir = join(buildRoot, 'node_modules/@holo-js/cli')
      await mkdir(cliStubDir, { recursive: true })
      await writeFile(
        join(cliStubDir, 'package.json'),
        JSON.stringify({
          name: '@holo-js/cli',
          type: 'module',
          exports: './index.mjs',
        }),
      )
      await writeFile(
        join(cliStubDir, 'index.mjs'),
        'export async function runCli(args, context) {\n'
        + '  context.stdout.write(`${JSON.stringify(args)}\\n`)\n'
        + '  return 0\n'
        + '}\n',
      )

      return { outDir }
    })()
  }

  return packageBuildPromise
}

afterAll(async () => {
  for (const root of tempBuildRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

afterEach(() => {
  process.argv = originalArgv
  process.exitCode = originalExitCode
  runCliMock.mockReset()
  vi.restoreAllMocks()
})

describe('create-holo-js bin', () => {
  it('declares the Node executable shebang in source', async () => {
    const source = await readFile(resolve(packageDir, 'src/bin/create-holo-js.ts'), 'utf8')

    expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true)
  })

  it('forwards arguments through the CLI new command', async () => {
    process.argv = ['node', 'create-holo-js', 'demo-app']
    runCliMock.mockResolvedValue(7)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
      throw new Error(`exit:${String(code)}`)
    }) as typeof process.exit)
    const modulePath = `../src/bin/create-holo-js.ts?run=${Date.now()}`

    await import(modulePath)

    expect(runCliMock).toHaveBeenCalledWith(['new', 'demo-app'], {
      cwd: process.cwd(),
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    })
    expect(exitSpy).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(7)
  })

  it('emits and executes the published bin through the OS command path', async () => {
    const build = await runPackageBuild()
    const binPath = resolve(build.outDir, 'bin/create-holo-js.mjs')
    const bin = await readFile(binPath, 'utf8')

    expect(bin.startsWith('#!/usr/bin/env node\n')).toBe(true)
    expect(bin).toContain('process.exitCode = exitCode')
    expect(bin).not.toContain('process.exit(')

    await chmod(binPath, 0o755)

    const output = execFileSync(binPath, ['--help'], {
      cwd: packageDir,
      encoding: 'utf8',
      stdio: 'pipe',
    })

    expect(output).toBe('["new","--help"]\n')
  }, 60000)
})
