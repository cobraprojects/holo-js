import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { renderFrameworkRunner } from '../src/project/scaffold/framework-renderers'
import { runRuntimeInvocation } from '../src/runtime'

const nextConflictBlock = (port: number, pid: string, dir: string) => [
  '⨯ Another next dev server is already running.',
  '',
  `- Local:        http://localhost:${port}`,
  `- PID:          ${pid}`,
  `- Dir:          ${dir}`,
  '- Log:          .next/dev/logs/next-development.log',
  '',
  `You can access the existing server at http://localhost:${port},`,
  `or run kill ${pid} to stop it and start a new one.`,
  '',
].join('\n')

const fakeNextBinary = `#!${process.execPath}
if (process.argv.includes('--hold')) {
  process.on('SIGTERM', () => console.log('signaled SIGTERM'))
  process.on('SIGINT', () => console.log('signaled SIGINT'))
  console.log('ready')
  setInterval(() => {}, 1000)
} else {
  console.error(process.env.HOLO_TEST_NEXT_STDERR)
  process.exit(1)
}
`

const portInUseStderr = [
  '⨯ Failed to start server',
  'Error: listen EADDRINUSE: address already in use :::3000',
  '    at new Promise (<anonymous>) {',
  "  code: 'EADDRINUSE',",
  '  errno: -48,',
  "  syscall: 'listen',",
  "  address: '::',",
  '  port: 3000',
  '}',
].join('\n')

const tempDirs: string[] = []
const holders: ChildProcess[] = []

afterEach(async () => {
  for (const holder of holders.splice(0)) {
    holder.kill('SIGKILL')
  }
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function createNextProject(): Promise<{ projectRoot: string, runnerPath: string, binaryPath: string }> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'holo-dev-conflict-'))
  tempDirs.push(projectRoot)
  const runnerDir = join(projectRoot, '.holo-js/framework')
  const packageDir = join(projectRoot, 'node_modules/next')
  const binaryPath = join(packageDir, 'bin/next.js')
  const shimPath = join(projectRoot, 'node_modules/.bin/next')
  await mkdir(runnerDir, { recursive: true })
  await mkdir(join(packageDir, 'bin'), { recursive: true })
  await mkdir(join(projectRoot, 'node_modules/.bin'), { recursive: true })
  await writeFile(join(runnerDir, 'project.json'), JSON.stringify({ framework: 'next' }))
  await writeFile(join(runnerDir, 'run.mjs'), renderFrameworkRunner({ framework: 'next' }))
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: 'next', version: '0.0.0', bin: { next: 'bin/next.js' } }))
  await writeFile(binaryPath, fakeNextBinary)
  await writeFile(shimPath, fakeNextBinary)
  await chmod(shimPath, 0o755)
  return { projectRoot, runnerPath: join(runnerDir, 'run.mjs'), binaryPath }
}

function runDevRunner(
  runnerPath: string,
  projectRoot: string,
  env: Record<string, string>,
) {
  return runRuntimeInvocation(process.execPath, [runnerPath, 'dev'], {
    cwd: projectRoot,
    env: { ...process.env, ...env },
  })
}

function startOwnServer(binaryPath: string): Promise<{ holder: ChildProcess, output: () => string }> {
  return new Promise((resolveHolder, rejectHolder) => {
    const holder = spawn(process.execPath, [binaryPath, 'dev', '--hold'], { stdio: ['ignore', 'pipe', 'inherit'] })
    holders.push(holder)
    const chunks: string[] = []
    holder.once('error', rejectHolder)
    holder.stdout?.on('data', chunk => chunks.push(String(chunk)))
    holder.stdout?.once('data', () => resolveHolder({ holder, output: () => chunks.join('') }))
  })
}

describe('holo dev port conflicts', () => {
  it('exits non-zero and names the port when another process holds it', async () => {
    const { projectRoot, runnerPath } = await createNextProject()

    const result = await runDevRunner(runnerPath, projectRoot, { HOLO_TEST_NEXT_STDERR: portInUseStderr })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('[holo] Port 3000 is already in use by another process.')
  }, 20_000)

  it('exits non-zero, names the port and PID, and leaves this project\'s own dev server running', async () => {
    const { projectRoot, runnerPath, binaryPath } = await createNextProject()
    const { holder, output } = await startOwnServer(binaryPath)

    const result = await runDevRunner(runnerPath, projectRoot, {
      HOLO_TEST_NEXT_STDERR: nextConflictBlock(3997, String(holder.pid), await realpath(projectRoot)),
    })
    await new Promise(resolve => setTimeout(resolve, 200))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Another holo dev for this project is already running on port 3997')
    expect(result.stderr).toContain(`(PID ${holder.pid})`)
    expect(holder.exitCode).toBeNull()
    expect(holder.signalCode).toBeNull()
    expect(output()).not.toContain('signaled')
  }, 20_000)

  it('exits non-zero and names the PID when the conflicting dev server belongs to another directory', async () => {
    const { projectRoot, runnerPath } = await createNextProject()

    const result = await runDevRunner(runnerPath, projectRoot, {
      HOLO_TEST_NEXT_STDERR: nextConflictBlock(3997, '4242', '/elsewhere/next-app'),
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Another Next dev server (PID 4242) is already running on port 3997 in /elsewhere/next-app')
    expect(result.stderr).not.toContain('Another holo dev for this project')
  }, 20_000)
})
