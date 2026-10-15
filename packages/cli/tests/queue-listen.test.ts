import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync, watch, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { runQueueListen } from '../src/queue'

it('starts replacement queue workers after preparation finishes without watching generated output', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'holo-queue-listen-'))
  const configPath = join(projectRoot, 'framework.json')
  await mkdir(join(projectRoot, 'config'))
  await writeFile(join(projectRoot, 'config/app.mjs'), 'export default {}')
  await writeFile(join(projectRoot, 'config/database.mjs'), 'export default {}')
  await writeFile(configPath, '{}')
  const watcher = watch(projectRoot, () => {})
  let notifyChange = (_path = 'server/jobs/updated.ts') => {}
  const createWatcher: NonNullable<Parameters<typeof runQueueListen>[4]> = (_path, _options, listener) => {
    notifyChange = (path = 'server/jobs/updated.ts') => listener('change', path)
    return watcher
  }
  const children: ReturnType<typeof spawn>[] = []
  const spawnWorker: NonNullable<Parameters<typeof runQueueListen>[3]> = (command) => {
    JSON.parse(readFileSync(configPath, 'utf8'))
    const child = spawn(command, ['-e', children.length === 0
      ? 'setInterval(() => {}, 1000)'
      : 'process.exit(0)'], { stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(child)
    return child
  }
  let finishPreparation = () => {}
  const preparationGate = new Promise<void>((resolve) => { finishPreparation = resolve })
  let preparations = 0
  const prepare = async () => {
    preparations += 1
    if (preparations === 2) {
      await setImmediate()
      notifyChange()
    }
    if (preparations === 3) {
      writeFileSync(configPath, '')
      await preparationGate
      await writeFile(configPath, '{}')
    }
    if (preparations > 1) notifyChange('.holo-js/generated/nuxt-init.ts')
  }
  const listening = runQueueListen({
    cwd: projectRoot,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  }, projectRoot, {}, spawnWorker, createWatcher, prepare).then(() => undefined, (error: unknown) => error)
  try {
    await expect.poll(() => children[0]).toBeDefined()
    const initialWorker = children[0]
    if (!initialWorker) throw new Error('Expected the initial worker')
    const stopped = once(initialWorker, 'close')
    notifyChange()
    await stopped
    await expect.poll(() => preparations).toBe(3)
    await setImmediate()
    finishPreparation()
    await expect(listening).resolves.toBeUndefined()
  } finally {
    finishPreparation()
    watcher.close()
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, 'close')
        child.kill('SIGKILL')
        await stopped
      }
    }
    await listening
    await rm(projectRoot, { recursive: true, force: true })
  }
})
