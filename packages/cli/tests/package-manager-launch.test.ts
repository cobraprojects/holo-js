import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { installProjectDependencies, resolvePackageManagerSpawn } from '../src/package-manager'

function createClosingProcess(onKill: () => void = () => {}): ReturnType<typeof spawn> {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter, stderr: EventEmitter, kill(): boolean }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => {
    onKill()
    return true
  }
  process.nextTick(() => child.emit('close', 0))
  return child as unknown as ReturnType<typeof spawn>
}

async function createInstallProject(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'holo-package-manager-install-'))
  onTestFinished(() => rm(projectRoot, { recursive: true, force: true }))
  await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ name: 'install-app', private: true }))
  return projectRoot
}

function createIo(cwd: string) {
  return { cwd, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }
}

async function runInShell(invocation: ReturnType<typeof resolvePackageManagerSpawn>): Promise<string> {
  const child = spawn(invocation.command, [...invocation.args], { shell: invocation.shell, stdio: ['ignore', 'pipe', 'inherit'] })
  let stdout = ''
  child.stdout?.on('data', chunk => stdout += String(chunk))
  await once(child, 'close')
  return stdout
}

it('delivers package-manager arguments unchanged whether they are quoted for the Windows shell or spawned directly', async () => {
  const args = ['-p', 'JSON.stringify(process.argv.slice(1))', 'install app', 'say "hi"']

  const windowsOutput = await runInShell(resolvePackageManagerSpawn({ command: 'node', args }, 'win32'))
  const directOutput = await runInShell(resolvePackageManagerSpawn({ command: 'node', args }, 'linux'))

  expect(JSON.parse(windowsOutput)).toEqual(['install app', 'say "hi"'])
  expect(JSON.parse(directOutput)).toEqual(['install app', 'say "hi"'])
})

it('does not spawn the package manager when the install is cancelled during the lookup', async () => {
  const projectRoot = await createInstallProject()
  const controller = new AbortController()
  const spawned: string[] = []
  const installation = installProjectDependencies(
    createIo(projectRoot),
    projectRoot,
    ((command: string) => {
      spawned.push(command)
      return createClosingProcess()
    }) as unknown as typeof spawn,
    controller.signal,
  )

  controller.abort()

  await expect(installation).rejects.toMatchObject({ name: 'AbortError' })
  expect(spawned).toEqual([])
})

it('does not signal an install child that already closed when the shared signal aborts later', async () => {
  const projectRoot = await createInstallProject()
  const controller = new AbortController()
  let signalled = 0

  await installProjectDependencies(
    createIo(projectRoot),
    projectRoot,
    (() => createClosingProcess(() => { signalled += 1 })) as unknown as typeof spawn,
    controller.signal,
  )
  controller.abort()
  await new Promise(resolve => setImmediate(resolve))

  expect(signalled).toBe(0)
})
