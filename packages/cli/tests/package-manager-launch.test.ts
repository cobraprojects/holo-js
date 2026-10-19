import type { spawn } from 'node:child_process'
import { EventEmitter, getEventListeners } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { installProjectDependencies, resolvePackageManagerSpawn } from '../src/package-manager'

function createClosingProcess(): ReturnType<typeof spawn> {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter, stderr: EventEmitter, kill(): boolean }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => true
  process.nextTick(() => child.emit('close', 0))
  return child as unknown as ReturnType<typeof spawn>
}

async function createInstallProject(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'holo-package-manager-install-'))
  onTestFinished(() => rm(projectRoot, { recursive: true, force: true }))
  await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ name: 'install-app', private: true }))
  return projectRoot
}

const io = { cwd: process.cwd(), stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }

it('launches package-manager shims through the shell on Windows and directly elsewhere', () => {
  expect(resolvePackageManagerSpawn({ command: 'npm', args: ['exec', '--', 'nuxt', 'prepare'] }, 'win32')).toEqual({
    command: 'npm exec -- nuxt prepare',
    args: [],
    shell: true,
  })
  expect(resolvePackageManagerSpawn({ command: 'node', args: ['-e', 'require("node:fs").appendFileSync("a b.txt", "x")'] }, 'win32')).toEqual({
    command: 'node -e "require(\\"node:fs\\").appendFileSync(\\"a b.txt\\", \\"x\\")"',
    args: [],
    shell: true,
  })
  expect(resolvePackageManagerSpawn({ command: 'pnpm', args: ['install'] }, 'linux')).toEqual({
    command: 'pnpm',
    args: ['install'],
    shell: false,
  })
})

it('does not spawn the package manager when the install is cancelled during the lookup', async () => {
  const projectRoot = await createInstallProject()
  const controller = new AbortController()
  const spawned: string[] = []
  const installation = installProjectDependencies(
    io,
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

it('removes its abort listener once each install child closes', async () => {
  const projectRoot = await createInstallProject()
  const controller = new AbortController()

  for (let cycle = 0; cycle < 3; cycle += 1) {
    await installProjectDependencies(io, projectRoot, (() => createClosingProcess()) as unknown as typeof spawn, controller.signal)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  }
})
