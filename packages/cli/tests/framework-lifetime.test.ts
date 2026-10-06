import { ChildProcess, type spawn } from 'node:child_process'
import type { watch, WatchListener } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProjectDevServer, runProjectStartServer } from '../src/dev'
import type { IoStreams } from '../src/cli-types'

const tempDirs: string[] = []

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-lifetime-'))
  tempDirs.push(root)
  await mkdir(join(root, 'config'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'lifetime-fixture', type: 'module' }))
  await writeFile(join(root, 'config/app.ts'), 'export default { name: \'Lifetime fixture\' }')
  await writeFile(join(root, 'config/database.ts'), 'export default {}')
  return root
}

function createIo(root: string): IoStreams {
  return {
    cwd: root,
    stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    stdout: new PassThrough() as unknown as NodeJS.WriteStream,
    stderr: new PassThrough() as unknown as NodeJS.WriteStream,
  }
}

function createChild(): ChildProcess {
  const child = new ChildProcess()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn(() => true)
  return child
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe.each(['dev', 'start'] as const)('%s stream lifetime', (mode) => {
  it.each(['close', 'error', 'launch failure'] as const)('releases streams and signals after %s', async (outcome) => {
    const root = await createProject()
    const io = createIo(root)
    const child = createChild()
    const listeners = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') }
    const output: string[] = []
    const errors: string[] = []
    io.stdout.on('data', chunk => output.push(String(chunk)))
    io.stderr.on('data', chunk => errors.push(String(chunk)))
    const input: string[] = []
    child.stdin?.on('data', chunk => input.push(String(chunk)))
    const closeWatcher = vi.fn()
    const createWatcher = (() => ({ close: closeWatcher })) as unknown as typeof watch
    const spawnProcess = vi.fn(() => {
      if (outcome === 'launch failure') throw new Error('launch failed')
      return child
    }) as unknown as typeof spawn
    const run = mode === 'dev'
      ? runProjectDevServer(io, root, spawnProcess, createWatcher, async () => {}, ['--port=3000'])
      : runProjectStartServer(io, root, spawnProcess, ['--port=3000'])
    const completion = outcome === 'close'
      ? expect(run).resolves.toBeUndefined()
      : expect(run).rejects.toThrow(outcome === 'error' ? 'process failed' : 'launch failed')
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce())
    if (outcome !== 'launch failure') {
      child.stdout?.emit('data', 'active output')
      child.stderr?.emit('data', 'active error')
      io.stdin.emit('data', 'active input')
      expect(output).toEqual(['active output'])
      expect(errors).toEqual(['active error'])
      expect(input).toEqual(['active input'])
      if (outcome === 'close') child.emit('close', 0)
      else child.emit('error', new Error('process failed'))
    }
    await completion
    child.stdout?.emit('data', 'late output')
    child.stderr?.emit('data', 'late error')
    io.stdin.emit('data', 'late input')
    expect(output).toEqual(outcome === 'launch failure' ? [] : ['active output'])
    expect(errors).toEqual(outcome === 'launch failure' ? [] : ['active error'])
    expect(input).toEqual(outcome === 'launch failure' ? [] : ['active input'])
    expect(process.listeners('SIGINT')).toEqual(listeners.SIGINT)
    expect(process.listeners('SIGTERM')).toEqual(listeners.SIGTERM)
    if (mode === 'dev') expect(closeWatcher).toHaveBeenCalledOnce()
  })
})

it.each(['close', 'error', 'throw'] as const)('waits for closure and handles restart termination %s', async (outcome) => {
  const root = await createProject()
  const io = createIo(root)
  const children: ChildProcess[] = []
  let observeChange: WatchListener<string> | undefined
  const closeWatcher = vi.fn()
  const createWatcher = ((_path: string, _options: { recursive?: boolean }, callback: WatchListener<string>) => {
    observeChange = callback
    return { close: closeWatcher }
  }) as unknown as typeof watch
  const spawnProcess = vi.fn(() => {
    const child = createChild()
    child.kill = vi.fn(() => {
      if (outcome === 'throw') throw new Error('termination failed')
      return true
    })
    children.push(child)
    return child
  }) as unknown as typeof spawn
  const run = runProjectDevServer(io, root, spawnProcess, createWatcher, async () => {}, ['--port=3000'])
  const completion = outcome === 'close'
    ? expect(run).resolves.toBeUndefined()
    : expect(run).rejects.toThrow(outcome === 'throw' ? 'termination failed' : 'stop failed')
  try {
    await vi.waitFor(() => expect(children).toHaveLength(1))
    const first = children[0]!
    observeChange?.('change', 'config/app.ts')
    await vi.waitFor(() => expect(first.kill).toHaveBeenCalledWith('SIGTERM'))
    expect(children).toHaveLength(1)
    if (outcome === 'close') {
      first.emit('close', 0)
      await vi.waitFor(() => expect(children).toHaveLength(2))
      children[1]?.emit('close', 0)
    } else if (outcome === 'error') {
      first.emit('error', new Error('stop failed'))
    }
    await completion
    first.emit('close', 0)
    await new Promise(resolve => setImmediate(resolve))
    expect(children).toHaveLength(outcome === 'close' ? 2 : 1)
    expect(closeWatcher).toHaveBeenCalledOnce()
  } finally {
    for (const child of children) child.emit('close', 0)
    await run.catch(() => undefined)
  }
})
