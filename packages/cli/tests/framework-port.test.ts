import { spawnSync } from 'node:child_process'
import type { watch } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProjectDevServer, runProjectStartServer } from '../src/dev'
import type { IoStreams } from '../src/cli-types'
import { renderFrameworkRunner } from '../src/project/scaffold/framework-renderers'

const tempDirs: string[] = []
const createInertWatcher = (() => ({ close() {} })) as unknown as typeof watch
const frameworks = [
  { framework: 'next', binary: 'next', entry: 'node_modules/.bin/next' },
  { framework: 'nuxt', binary: 'nuxt', entry: '.output/server/index.mjs' },
  { framework: 'sveltekit', binary: 'vite', entry: 'build/index.js' },
] as const

async function writeFrameworkProgram(
  root: string,
  framework: typeof frameworks[number],
  mode: 'dev' | 'start',
  source: readonly string[],
): Promise<void> {
  const usesFrameworkBinary = mode === 'dev' || framework.framework === 'next'
  if (process.platform === 'win32' && usesFrameworkBinary) {
    const packageName = framework.framework === 'sveltekit' ? 'vite' : framework.framework
    const packageRoot = join(root, 'node_modules', packageName)
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'test-framework.mjs'), source.join('\n'))
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: packageName,
      bin: { [framework.binary]: 'test-framework.mjs' },
    }))
    return
  }

  const entry = usesFrameworkBinary
    ? join(root, 'node_modules/.bin', framework.binary)
    : join(root, framework.entry)
  await mkdir(dirname(entry), { recursive: true })
  await writeFile(entry, ['#!/usr/bin/env node', ...source].join('\n'))
  await chmod(entry, 0o755)
}

async function createRunner(framework: typeof frameworks[number], mode: 'dev' | 'start'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-port-'))
  tempDirs.push(root)
  const runner = join(root, '.holo-js/framework/run.mjs')
  await mkdir(dirname(runner), { recursive: true })
  await writeFile(runner, renderFrameworkRunner(framework))
  await writeFile(join(dirname(runner), 'project.json'), JSON.stringify(framework))
  await writeFrameworkProgram(root, framework, mode, [
    'console.log(JSON.stringify({ args: process.argv.slice(2), port: process.env.PORT, nitroPort: process.env.NITRO_PORT }))',
  ])
  return runner
}

async function getAvailablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  await new Promise<void>((resolvePromise, reject) => {
    server.close(error => error ? reject(error) : resolvePromise())
  })
  if (!address || typeof address === 'string') throw new Error('Could not allocate a test port.')
  return address.port
}

async function assertPortIsReleased(port: number): Promise<void> {
  const server = createServer()
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolvePromise)
  })
  await new Promise<void>((resolvePromise, reject) => {
    server.close(error => error ? reject(error) : resolvePromise())
  })
}

function killProcessIfRunning(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
  }
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe.each(frameworks)('$framework port configuration', (framework) => {
  it('forwards dev arguments to the framework binary', async () => {
    const runner = await createRunner(framework, 'dev')
    const result = spawnSync(process.execPath, [runner, 'dev', '--port=4334'], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ args: ['dev', '--port=4334'] })
  })

  it('preserves inherited production ports when no override is given', async () => {
    const runner = await createRunner(framework, 'start')
    const result = spawnSync(process.execPath, [runner, 'start'], {
      encoding: 'utf8',
      env: { ...process.env, PORT: '3000', NITRO_PORT: '3001' },
    })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ port: '3000', nitroPort: '3001' })
  })

  it.skipIf(framework.framework === 'next').each(['--port=433434', '--port=abc', '--port=', '--port'])(
    'rejects invalid production port %s before launching the server', async (arg) => {
      const runner = await createRunner(framework, 'start')
      const result = spawnSync(process.execPath, [runner, 'start', arg], { encoding: 'utf8' })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('--port must be an integer between 0 and 65535')
      expect(result.stdout).toBe('')
    },
  )

  it.each([['--port=4334'], ['--port', '4334']])('applies production port %j over inherited environment', async (...args) => {
    const runner = await createRunner(framework, 'start')
    const result = spawnSync(process.execPath, [runner, 'start', ...args], {
      encoding: 'utf8',
      env: { ...process.env, PORT: '3000', NITRO_PORT: '3001' },
    })
    expect(result.status, result.stderr).toBe(0)
    const output = JSON.parse(result.stdout) as { args: string[], port: string, nitroPort: string }
    if (framework.framework === 'next') {
      expect(output.args).toEqual(['start', ...args])
      return
    }
    expect(output.args).toEqual([])
    expect(output.port).toBe('4334')
    if (framework.framework === 'nuxt') {
      expect(output.nitroPort).toBe('4334')
    }
  })
})

it.each([
  { mode: 'dev', signal: 'SIGINT' },
  { mode: 'dev', signal: 'SIGTERM' },
  { mode: 'start', signal: 'SIGINT' },
  { mode: 'start', signal: 'SIGTERM' },
] as const)('stops the framework process when holo $mode receives $signal', async ({ mode, signal }) => {
  const framework = frameworks[2]
  const runner = await createRunner(framework, mode)
  const root = resolve(dirname(runner), '../..')
  const port = await getAvailablePort()
  const pidPath = join(root, 'framework.pid')
  await writeFrameworkProgram(root, framework, mode, [
    'import { writeFileSync } from \'node:fs\'',
    'import { createServer } from \'node:http\'',
    `const pidPath = ${JSON.stringify(pidPath)}`,
    `const port = ${port}`,
    'const server = createServer((_request, response) => response.end(\'ready\'))',
    'for (const signal of [\'SIGINT\', \'SIGTERM\']) {',
    '  process.on(signal, () => {',
    '    server.close(() => process.exit(0))',
    '  })',
    '}',
    'server.listen(port, \'127.0.0.1\', () => writeFileSync(pidPath, String(process.pid)))',
  ])
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'shutdown-fixture', type: 'module' }))
  await mkdir(join(root, 'config'), { recursive: true })
  await writeFile(join(root, 'config/app.ts'), 'export default { name: \'Shutdown fixture\' }')
  await writeFile(join(root, 'config/database.ts'), 'export default {}')

  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const io: IoStreams = {
    cwd: root,
    stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
  }
  const previousSignalListeners = new Set(process.listeners(signal))
  let frameworkPid: number | undefined
  const commandPromise = mode === 'dev'
    ? runProjectDevServer(io, root, undefined, createInertWatcher, async () => {}, ['--port', String(port)])
    : runProjectStartServer(io, root, undefined, ['--port', String(port)])

  try {
    await vi.waitFor(async () => {
      frameworkPid = Number(await readFile(pidPath, 'utf8'))
      expect(frameworkPid).toBeGreaterThan(0)
    })
    await vi.waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}`)
      await expect(response.text()).resolves.toBe('ready')
    })
    const signalListener = process.listeners(signal)
      .find(listener => !previousSignalListeners.has(listener))
    expect(signalListener).toBeDefined()
    signalListener?.(signal)

    await expect(commandPromise).resolves.toBeUndefined()
    await assertPortIsReleased(port)
    expect(process.listeners(signal).every(listener => previousSignalListeners.has(listener))).toBe(true)
  } finally {
    if (frameworkPid) {
      killProcessIfRunning(frameworkPid)
    }
    await commandPromise.catch(() => undefined)
  }
})

describe.each(frameworks)('$framework environment port', (framework) => {
  describe.each(['dev', 'start'] as const)('%s', (mode) => {
    it.each([
      { source: '.env', shell: undefined, args: [], expected: '1500' },
      { source: 'framework default', shell: undefined, args: [], expected: undefined },
      { source: 'shell over .env', shell: '2500', args: [], expected: '2500' },
      { source: 'explicit over shell and .env', shell: '2500', args: ['--port=3500'], expected: '3500' },
    ])('uses $source', async ({ shell, args, expected }) => {
      vi.stubEnv('PORT', shell)
      vi.stubEnv('NITRO_PORT', undefined)
      vi.stubEnv('NUXT_PORT', undefined)
      const runner = await createRunner(framework, mode)
      const root = resolve(dirname(runner), '../..')
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'port-fixture', type: 'module' }))
      if (expected) await writeFile(join(root, '.env'), 'PORT="1500"\n')
      await mkdir(join(root, 'config'), { recursive: true })
      await writeFile(join(root, 'config/app.ts'), 'export default { name: "Port fixture" }')
      await writeFile(join(root, 'config/database.ts'), 'export default {}')
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      let output = ''
      let errors = ''
      stdout.on('data', chunk => { output += String(chunk) })
      stderr.on('data', chunk => { errors += String(chunk) })
      const io: IoStreams = {
        cwd: root,
        stdin: new PassThrough() as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
      }
      if (mode === 'dev') {
        await runProjectDevServer(io, root, undefined, createInertWatcher, async () => {}, args)
      } else {
        await runProjectStartServer(io, root, undefined, args)
      }
      expect(errors).toBe('')
      const result = JSON.parse(output) as { args: string[], port?: string, nitroPort?: string }
      if (mode === 'dev' || framework.framework === 'next') {
        expect(result.args).toEqual([mode, ...args.length ? args : expected ? ['--port', expected] : []])
      } else {
        expect(result.port).toBe(expected)
        if (framework.framework === 'nuxt') expect(result.nitroPort).toBe(expected)
      }
      expect(process.env.PORT).toBe(shell)
    })
  })
})
