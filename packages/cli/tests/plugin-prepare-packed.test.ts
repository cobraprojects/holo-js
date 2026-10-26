import { execFile, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../src/cli'
import type { IoStreams } from '../src/cli-types'
import { runProjectPrepare } from '../src/dev'
import { syncManagedDriverDependencies } from '../src/project'
import { symlinkPackageDependency } from '../../../tests/support/published-package'

const execFileAsync = promisify(execFile)
const fixtureRoot = resolve(import.meta.dirname, 'fixtures/generic-project-plugin')
const repositoryRoot = resolve(import.meta.dirname, '../../..')
const temporaryDirectories: string[] = []

async function buildPublicCli(): Promise<string> {
  const packageRoot = join(repositoryRoot, 'packages/cli')
  const buildRoot = await mkdtemp(join(tmpdir(), 'holo-cli-public-build-'))
  temporaryDirectories.push(buildRoot)
  const outDir = join(buildRoot, 'dist')
  await execFileAsync('bun', ['run', 'build'], {
    cwd: packageRoot,
    env: { ...process.env, HOLO_BUILD_OUT_DIR: outDir },
  })
  await symlink(join(packageRoot, 'node_modules'), join(buildRoot, 'node_modules'), 'dir')
  return join(outDir, 'bin/holo.mjs')
}

function createIo(projectRoot: string): IoStreams {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream
  const stderr = new PassThrough() as unknown as NodeJS.WriteStream

  return {
    cwd: projectRoot,
    stdin,
    stdout,
    stderr,
  }
}

async function createPackedPlugin(): Promise<string> {
  const packRoot = await mkdtemp(join(tmpdir(), 'holo-generic-plugin-pack-'))
  temporaryDirectories.push(packRoot)
  const { stdout } = await execFileAsync('npm', [
    'pack',
    fixtureRoot,
    '--json',
    '--pack-destination',
    packRoot,
  ])
  const result = JSON.parse(stdout) as Array<{ filename: string }>
  const filename = result[0]?.filename
  if (!filename) {
    throw new Error('npm pack did not report the generic plugin tarball.')
  }
  return join(packRoot, filename)
}

async function declareAndLinkHoloPackage(
  projectRoot: string,
  packageName: `@holo-js/${string}`,
  packageDirectory: string,
): Promise<void> {
  const packageJsonPath = join(projectRoot, 'package.json')
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
    dependencies?: Record<string, string>
  }
  const packageRoot = join(repositoryRoot, 'packages', packageDirectory)
  const workspacePackage = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
    version: string
  }
  await writeFile(packageJsonPath, `${JSON.stringify({
    ...packageJson,
    dependencies: {
      ...packageJson.dependencies,
      [packageName]: `^${workspacePackage.version}`,
    },
  }, null, 2)}\n`)
  await symlinkPackageDependency(join(projectRoot, 'node_modules'), packageName, packageRoot)
}

async function createProjectWithPackedPlugin(tarballPath: string): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'holo-packed-plugin-project-'))
  temporaryDirectories.push(projectRoot)
  await mkdir(join(projectRoot, 'config'), { recursive: true })
  await mkdir(join(projectRoot, 'data'), { recursive: true })
  await writeFile(join(projectRoot, 'package.json'), `${JSON.stringify({
    name: 'packed-plugin-project',
    private: true,
    type: 'module',
  }, null, 2)}\n`)
  await execFileAsync('npm', [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    tarballPath,
  ], { cwd: projectRoot })
  await declareAndLinkHoloPackage(projectRoot, '@holo-js/core', 'core')
  await declareAndLinkHoloPackage(projectRoot, '@holo-js/db', 'db')
  await declareAndLinkHoloPackage(projectRoot, '@holo-js/db-sqlite', 'db-sqlite')
  await declareAndLinkHoloPackage(projectRoot, '@holo-js/kernel', 'kernel')
  await declareAndLinkHoloPackage(projectRoot, '@holo-js/adapter-next', 'adapter-next')
  const frameworkRoot = join(projectRoot, '.holo-js/framework')
  const packageRoot = join(projectRoot, 'node_modules/next')
  await mkdir(frameworkRoot, { recursive: true })
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'next', type: 'module', bin: { next: 'cli.mjs' } }))
  await writeFile(join(frameworkRoot, 'project.json'), '{"framework":"next"}\n')
  const fakeFrameworkModule = join(packageRoot, 'cli.mjs')
  await writeFile(fakeFrameworkModule, `import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const outputRoot = join(process.cwd(), '.generic-project-fixture')
await mkdir(outputRoot, { recursive: true })
await writeFile(join(outputRoot, 'framework.json'), JSON.stringify({ mode: process.argv[2] }))
`)
  await writeFile(join(projectRoot, 'config/app.mjs'), `export default {
  plugins: [],
}\n`)
  await syncManagedDriverDependencies(projectRoot)
  return projectRoot
}

async function readLifecycle(projectRoot: string): Promise<{
  command: string
  kind: string
  changes: Array<{ path: string, kind: string }>
  plugin: string
}> {
  const contents = await readFile(join(
    projectRoot,
    '.holo-js/generated/generic-project-fixture/lifecycle.json',
  ), 'utf8')
  return JSON.parse(contents) as {
    command: string
    kind: string
    changes: Array<{ path: string, kind: string }>
    plugin: string
  }
}

async function runPublicHoloLifecycle(
  projectRoot: string,
  publicCliEntrypoint: string,
  command: 'dev' | 'build',
): Promise<void> {
  const child = spawn('node', [publicCliEntrypoint, command], {
    cwd: projectRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => stdout += chunk.toString())
  child.stderr.on('data', chunk => stderr += chunk.toString())
  const closed = new Promise<{ code: number | null, signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolvePromise({ code, signal }))
  })
  try {
    const observed = await vi.waitFor(async () => {
      const lifecycle = await readLifecycle(projectRoot).catch(() => undefined)
      if (lifecycle?.command === command && lifecycle.kind === 'full') {
        return true
      }
      if (child.exitCode !== null) {
        return false
      }
      throw new Error('Public holo lifecycle is not prepared yet.')
    }, { timeout: 20_000, interval: 50 }).catch(() => false)

    if (!observed) {
      throw new Error(`Public holo ${command} did not prepare the plugin.\nstdout:\n${stdout}\nstderr:\n${stderr}`)
    }
    if (command === 'build') {
      expect(await closed, `stdout:\n${stdout}\nstderr:\n${stderr}`).toEqual({ code: 0, signal: null })
    }
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
    }
    await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`Public holo ${command} did not stop after SIGTERM.`)),
        5_000,
      )),
    ])
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
    force: true,
    recursive: true,
  })))
})

describe('packed external project plugin', () => {
  it('loads its command and prepares owned artifacts for prepare, dev, and build lifecycles', async () => {
    const publicCliEntrypoint = await buildPublicCli()
    const tarballPath = await createPackedPlugin()
    const projectRoot = await createProjectWithPackedPlugin(tarballPath)
    const io = createIo(projectRoot)

    await expect(runCli(['plugin:add', 'holo-generic-project-fixture'], io)).resolves.toBe(0)
    expect(await readLifecycle(projectRoot)).toEqual({
      command: 'prepare',
      kind: 'full',
      changes: [],
      plugin: 'generic-project-fixture',
    })
    await expect(readFile(join(
      projectRoot,
      'generated/generic-project-fixture.mjs',
    ), 'utf8')).resolves.toBe("export const genericProjectFixture = 'ready'\n")

    await expect(runCli(['generic:probe', 'first', '--mode=packed'], io)).resolves.toBe(0)
    const commandRecord = JSON.parse(await readFile(join(
      projectRoot,
      '.generic-project-fixture/command.json',
    ), 'utf8')) as {
      args: string[]
      cwd: string
      flags: Record<string, string>
      projectRoot: string
    }
    expect(commandRecord).toEqual({
      args: ['first'],
      cwd: projectRoot,
      flags: { mode: 'packed' },
      projectRoot,
    })

    await expect(runCli(['prepare'], io)).resolves.toBe(0)
    expect(await readLifecycle(projectRoot)).toEqual({
      command: 'prepare',
      kind: 'full',
      changes: [],
      plugin: 'generic-project-fixture',
    })
    await expect(readFile(join(
      projectRoot,
      'generated/generic-project-fixture.mjs',
    ), 'utf8')).resolves.toBe("export const genericProjectFixture = 'ready'\n")

    await runPublicHoloLifecycle(projectRoot, publicCliEntrypoint, 'dev')
    expect(await readLifecycle(projectRoot)).toEqual({
      command: 'dev',
      kind: 'full',
      changes: [],
      plugin: 'generic-project-fixture',
    })
    await runProjectPrepare(projectRoot, io, {
      syncFramework: false,
      command: 'dev',
      changes: [{ path: 'server/extensions/example.ts', kind: 'changed' }],
    })
    expect(await readLifecycle(projectRoot)).toEqual({
      command: 'dev',
      kind: 'incremental',
      changes: [{ path: 'server/extensions/example.ts', kind: 'changed' }],
      plugin: 'generic-project-fixture',
    })

    await runPublicHoloLifecycle(projectRoot, publicCliEntrypoint, 'build')
    expect(await readLifecycle(projectRoot)).toEqual({
      command: 'build',
      kind: 'full',
      changes: [],
      plugin: 'generic-project-fixture',
    })
    const ownershipManifest = JSON.parse(await readFile(join(
      projectRoot,
      '.holo-js/generated/.plugins/generic-project-fixture.json',
    ), 'utf8')) as {
      generatedArtifacts: Array<{ path: string }>
      managedArtifacts: Array<{ path: string }>
    }
    expect(ownershipManifest.generatedArtifacts.map(artifact => artifact.path)).toEqual([
      'lifecycle.json',
    ])
    expect(ownershipManifest.managedArtifacts.map(artifact => artifact.path)).toEqual([
      'generated/generic-project-fixture.mjs',
    ])

    const managedArtifactPath = join(projectRoot, 'generated/generic-project-fixture.mjs')
    await writeFile(managedArtifactPath, "export const genericProjectFixture = 'application-owned'\n")
    await expect(runProjectPrepare(projectRoot, io, {
      syncFramework: false,
      command: 'prepare',
      reason: 'explicit',
    })).rejects.toThrow('modified by the application')
    await expect(readFile(managedArtifactPath, 'utf8'))
      .resolves.toBe("export const genericProjectFixture = 'application-owned'\n")
  }, 90_000)
})
