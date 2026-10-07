import { ChildProcess, spawn } from 'node:child_process'
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
  vi.unstubAllEnvs()
  await Promise.all(tempDirs.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it.each([
  { closureFirst: true, args: [], expectedPort: '4300' },
  { closureFirst: false, args: [], expectedPort: '4300' },
  { closureFirst: true, args: ['--port=3000'], expectedPort: undefined },
  { closureFirst: true, args: [], expectedPort: '4200', failLast: true },
])('coalesces preparation before replacement with closureFirst=$closureFirst, args=$args and failLast=$failLast', async ({ closureFirst, args, expectedPort, failLast }) => {
  vi.stubEnv('PORT', undefined)
  const root = await createProject()
  await writeFile(join(root, '.env'), 'PORT=4100\n')
  const children: ChildProcess[] = []
  const launches: string[][] = []
  const spawnProcess = vi.fn((_command: string, serverArgs: readonly string[]) => {
    const child = createChild()
    children.push(child)
    launches.push([...serverArgs])
    return child
  }) as unknown as typeof spawn
  let observeChange: WatchListener<string> | undefined
  const createWatcher = ((_path: string, _options: { recursive?: boolean }, callback: WatchListener<string>) => {
    observeChange = callback
    return { close() {} }
  }) as unknown as typeof watch
  let preparationCount = 0
  let releasePreparation = () => {}
  const preparation = new Promise<void>(resolvePromise => { releasePreparation = resolvePromise })
  const prepare = async () => {
    preparationCount++
    if (preparationCount === 3) {
      await preparation
      await writeFile(join(root, '.env'), 'PORT=4200\n')
    }
    if (preparationCount === 4) {
      await writeFile(join(root, '.env'), failLast ? 'PORT=invalid\n' : 'PORT=4300\n')
    }
  }
  const io = createIo(root)
  let errors = ''
  io.stderr.on('data', chunk => { errors += String(chunk) })
  const run = runProjectDevServer(io, root, spawnProcess, createWatcher, prepare, args)
  try {
    await vi.waitFor(() => expect(children).toHaveLength(1))
    const first = children[0]!
    observeChange?.('change', 'config/app.ts')
    await vi.waitFor(() => expect(first.kill).toHaveBeenCalledOnce())
    observeChange?.('change', '.env')
    await vi.waitFor(() => expect(preparationCount).toBe(3))
    if (closureFirst) {
      first.emit('close', 0)
      await new Promise(resolve => setImmediate(resolve))
      expect(children).toHaveLength(1)
    }
    observeChange?.('rename', 'config/database.ts')
    releasePreparation()
    await vi.waitFor(() => expect(preparationCount).toBe(4))
    if (!closureFirst) {
      await new Promise(resolve => setImmediate(resolve))
      expect(children).toHaveLength(1)
      first.emit('close', 0)
    }
    await vi.waitFor(() => expect(children).toHaveLength(2))
    expect(launches[1]?.slice(args.length ? -args.length : -2)).toEqual(expectedPort ? ['--port', expectedPort] : args)
    expect(errors).toBe(failLast ? 'PORT must be an integer between 0 and 65535.\n' : '')
    if (failLast) await writeFile(join(root, '.env'), 'PORT=4300\n')
    observeChange?.('change', 'config/app.ts')
    await vi.waitFor(() => expect(children[1]?.kill).toHaveBeenCalledOnce())
    children[1]?.emit('close', 0)
    await vi.waitFor(() => expect(children).toHaveLength(3))
    children[2]?.emit('close', 0)
    await run
  } finally {
    releasePreparation()
    for (const child of children) child.emit('close', 0)
    await run.catch(() => undefined)
  }
})

it.each(['active', 'closed'] as const)('does not restart a %s framework run when preparation fails', async (state) => {
  const root = await createProject()
  await mkdir(join(root, '.holo-js/framework'), { recursive: true })
  await writeFile(join(root, '.holo-js/framework/run.mjs'), "process.on('SIGTERM', () => process.exit(0)); console.log('ready'); setInterval(() => {}, 1000)")
  const io = createIo(root)
  let output = ''
  let errors = ''
  io.stdout.on('data', chunk => { output += String(chunk) })
  io.stderr.on('data', chunk => { errors += String(chunk) })
  const children: ChildProcess[] = []
  const spawnProcess = ((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args)
    children.push(child)
    return child
  }) as typeof spawn
  let observeChange: WatchListener<string> | undefined
  const createWatcher = ((_path: string, _options: { recursive?: boolean }, callback: WatchListener<string>) => {
    observeChange = callback
    return { close() {} }
  }) as unknown as typeof watch
  let preparationCount = 0
  let releasePreparation = () => {}
  const preparation = new Promise<void>(resolvePromise => { releasePreparation = resolvePromise })
  const prepare = async () => {
    preparationCount++
    if (preparationCount > 1) {
      await preparation
      throw new Error('preparation failed')
    }
  }
  const run = runProjectDevServer(io, root, spawnProcess, createWatcher, prepare, ['--port=3000'])
  let completed = false
  const completion = run.then(() => { completed = true })
  try {
    await vi.waitFor(() => expect(output).toContain('ready'))
    observeChange?.('change', 'config/app.ts')
    await vi.waitFor(() => expect(preparationCount).toBe(2))
    const first = children[0]!
    if (state === 'closed') {
      const closed = new Promise<void>(resolvePromise => first.once('close', () => resolvePromise()))
      first.kill('SIGTERM')
      await closed
    }
    releasePreparation()
    if (state === 'active') {
      await vi.waitFor(() => expect(errors).toContain('preparation failed'))
      expect(completed).toBe(false)
      expect(first.exitCode).toBeNull()
      expect(first.signalCode).toBeNull()
      first.kill('SIGTERM')
    }
    await completion
    expect(children).toHaveLength(1)
  } finally {
    releasePreparation()
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    await run.catch(() => undefined)
  }
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


it('prevents launch when shutdown interrupts initial preparation and waits for preparation to settle', async () => {
  const root = await createProject()
  const io = createIo(root)
  const listeners = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') }
  const launches: ChildProcess[] = []
  let releasePreparation: () => void = () => {}
  let preparationStarted: () => void = () => {}
  const started = new Promise<void>(resolvePromise => { preparationStarted = resolvePromise })
  const preparation = new Promise<void>(resolvePromise => { releasePreparation = resolvePromise })
  const prepare = async () => {
    preparationStarted()
    await preparation
  }
  const spawnProcess = ((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args)
    launches.push(child)
    return child
  }) as typeof spawn
  const closeWatcher = vi.fn()
  const createWatcher = (() => ({ close: closeWatcher })) as unknown as typeof watch
  const command = runProjectDevServer(io, root, spawnProcess, createWatcher, prepare, ['--port=3000'])
  let completed = false
  const completion = command.then(() => { completed = true })
  try {
    await started
    const shutdown = process.listeners('SIGTERM').find(listener => !listeners.SIGTERM.includes(listener))
    expect(shutdown).toBeDefined()
    shutdown?.('SIGTERM')
    await new Promise(resolve => setImmediate(resolve))
    expect(completed).toBe(false)
    releasePreparation()
    await completion
    expect(launches).toHaveLength(0)
    expect(closeWatcher).not.toHaveBeenCalled()
    expect(process.listeners('SIGINT')).toEqual(listeners.SIGINT)
    expect(process.listeners('SIGTERM')).toEqual(listeners.SIGTERM)
  } finally {
    releasePreparation()
    await command.catch(() => undefined)
    for (const child of launches) child.kill()
  }
})

it.each(['shutdown', 'failure'] as const)('cleans up partially acquired fallback watchers after setup %s', async (outcome) => {
  const root = await createProject()
  await mkdir(join(root, 'server'))
  const io = createIo(root)
  const listeners = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') }
  const closeWatcher = vi.fn()
  const spawnProcess = vi.fn(spawn) as unknown as typeof spawn
  let acquired = false
  const createWatcher = ((_path: string, options: { recursive?: boolean }) => {
    if (options.recursive) throw Object.assign(new Error('unsupported'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' })
    if (!acquired) {
      acquired = true
      return { close: closeWatcher }
    }
    if (outcome === 'failure') throw new Error('watch setup failed')
    process.listeners('SIGINT').find(listener => !listeners.SIGINT.includes(listener))?.('SIGINT')
    return { close: closeWatcher }
  }) as unknown as typeof watch
  const command = runProjectDevServer(io, root, spawnProcess, createWatcher, async () => {}, ['--port=3000'])
  if (outcome === 'failure') await expect(command).rejects.toThrow('watch setup failed')
  else await expect(command).resolves.toBeUndefined()
  expect(spawnProcess).not.toHaveBeenCalled()
  expect(closeWatcher).toHaveBeenCalledTimes(outcome === 'failure' ? 1 : 2)
  expect(process.listeners('SIGINT')).toEqual(listeners.SIGINT)
  expect(process.listeners('SIGTERM')).toEqual(listeners.SIGTERM)
})

it('releases session signals when initial preparation fails', async () => {
  const root = await createProject()
  const listeners = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') }
  const spawnProcess = vi.fn(spawn) as unknown as typeof spawn
  const createWatcher = vi.fn()
  await expect(runProjectDevServer(createIo(root), root, spawnProcess, createWatcher, async () => {
    throw new Error('preparation failed')
  })).rejects.toThrow('preparation failed')
  expect(spawnProcess).not.toHaveBeenCalled()
  expect(createWatcher).not.toHaveBeenCalled()
  expect(process.listeners('SIGINT')).toEqual(listeners.SIGINT)
  expect(process.listeners('SIGTERM')).toEqual(listeners.SIGTERM)
})

it('delivers cancellation to a project preparer and waits for it to settle', async () => {
  const root = await createProject()
  await writeFile(join(root, 'config/app.ts'), "export default { plugins: ['shutdown-plugin'] }")
  const pluginRoot = join(root, 'node_modules/shutdown-plugin')
  await mkdir(pluginRoot, { recursive: true })
  await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
    name: 'shutdown-plugin', type: 'module', holo: { plugin: './plugin.mjs' },
  }))
  await writeFile(join(pluginRoot, 'plugin.mjs'), "export default { id: 'shutdown', contributes: { project: { prepare: './prepare.mjs' } } }")
  await writeFile(join(pluginRoot, 'prepare.mjs'), `export default {
    apiVersion: 1,
    async prepare(context) {
      context.logger.info('preparation started')
      await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }))
      context.logger.info('preparation cancelled')
      return { kind: 'prepared' }
    }
  }`)
  const io = createIo(root)
  let output = ''
  io.stdout.on('data', chunk => { output += String(chunk) })
  const listeners = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') }
  const spawnProcess = vi.fn(spawn) as unknown as typeof spawn
  const createWatcher = vi.fn()
  const command = runProjectDevServer(io, root, spawnProcess, createWatcher)
  try {
    await vi.waitFor(() => expect(output).toContain('preparation started'))
    process.listeners('SIGTERM').find(listener => !listeners.SIGTERM.includes(listener))?.('SIGTERM')
    await expect(command).resolves.toBeUndefined()
    expect(output).toContain('preparation cancelled')
    expect(spawnProcess).not.toHaveBeenCalled()
    expect(createWatcher).not.toHaveBeenCalled()
    expect(process.listeners('SIGINT')).toEqual(listeners.SIGINT)
    expect(process.listeners('SIGTERM')).toEqual(listeners.SIGTERM)
  } finally {
    process.listeners('SIGTERM').find(listener => !listeners.SIGTERM.includes(listener))?.('SIGTERM')
    await command.catch(() => undefined)
  }
})

it.each(['preparation', 'exit', 'close'] as const)('prevents replacement when shutdown arrives during restart %s', async (phase) => {
  const root = await createProject()
  await mkdir(join(root, '.holo-js/framework'), { recursive: true })
  await writeFile(join(root, '.holo-js/framework/run.mjs'), "console.log('ready'); setInterval(() => {}, 1000)")
  const io = createIo(root)
  const listeners = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') }
  const children: ChildProcess[] = []
  const spawnProcess = ((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args)
    children.push(child)
    return child
  }) as typeof spawn
  let observeChange: WatchListener<string> | undefined
  const closeWatcher = vi.fn()
  const createWatcher = ((_path: string, _options: { recursive?: boolean }, callback: WatchListener<string>) => {
    observeChange = callback
    return { close: closeWatcher }
  }) as unknown as typeof watch
  let preparationCount = 0
  let releasePreparation: () => void = () => {}
  const preparation = new Promise<void>(resolvePromise => { releasePreparation = resolvePromise })
  const prepare = async () => {
    preparationCount++
    if (phase === 'preparation' && preparationCount > 1) await preparation
  }
  let output = ''
  io.stdout.on('data', chunk => { output += String(chunk) })
  const command = runProjectDevServer(io, root, spawnProcess, createWatcher, prepare, ['--port=3000'])
  const shutdown = () => process.listeners('SIGTERM').find(listener => !listeners.SIGTERM.includes(listener))?.('SIGTERM')
  let completed = false
  const completion = command.then(() => { completed = true })
  try {
    await vi.waitFor(() => expect(output).toContain('ready'))
    const first = children[0]!
    if (phase !== 'preparation') first.once(phase, shutdown)
    observeChange?.('change', 'config/app.ts')
    if (phase === 'preparation') {
      await vi.waitFor(() => expect(preparationCount).toBe(2))
      observeChange?.('change', 'config/database.ts')
      shutdown()
      await new Promise<void>(resolvePromise => first.once('close', () => resolvePromise()))
      expect(completed).toBe(false)
      expect(closeWatcher).toHaveBeenCalledOnce()
      releasePreparation()
    }
    await completion
    expect(children).toHaveLength(1)
    expect(closeWatcher).toHaveBeenCalledOnce()
    const preparationsBeforeLateEvents = preparationCount
    observeChange?.('rename', 'config/app.ts')
    io.stdin.emit('data', 'late input')
    first.stdout?.emit('data', 'late output')
    await new Promise(resolve => setImmediate(resolve))
    expect(preparationCount).toBe(preparationsBeforeLateEvents)
    expect(output).toBe('ready\n')
    expect(process.listeners('SIGINT')).toEqual(listeners.SIGINT)
    expect(process.listeners('SIGTERM')).toEqual(listeners.SIGTERM)
  } finally {
    releasePreparation()
    shutdown()
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    await command.catch(() => undefined)
  }
})

it('prevents production launch when shutdown arrives before argument preparation finishes', async () => {
  const root = await createProject()
  const listeners = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') }
  const spawnProcess = vi.fn(spawn) as unknown as typeof spawn
  const command = runProjectStartServer(createIo(root), root, spawnProcess)
  const shutdown = process.listeners('SIGINT').find(listener => !listeners.SIGINT.includes(listener))
  expect(shutdown).toBeDefined()
  shutdown?.('SIGINT')
  await expect(command).resolves.toBeUndefined()
  expect(spawnProcess).not.toHaveBeenCalled()
  expect(process.listeners('SIGINT')).toEqual(listeners.SIGINT)
  expect(process.listeners('SIGTERM')).toEqual(listeners.SIGTERM)
})
