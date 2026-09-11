import { spawnSync } from 'node:child_process'
import { watch } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProjectDevServer, runProjectStartServer } from '../src/dev'
import type { IoStreams } from '../src/cli-types'
import { renderFrameworkRunner } from '../src/project/scaffold/framework-renderers'

const tempDirs: string[] = []
const frameworks = [
  { framework: 'next', binary: 'next', entry: 'node_modules/.bin/next' },
  { framework: 'nuxt', binary: 'nuxt', entry: '.output/server/index.mjs' },
  { framework: 'sveltekit', binary: 'vite', entry: 'build/index.js' },
] as const

async function createRunner(framework: typeof frameworks[number], mode: 'dev' | 'start'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-port-'))
  tempDirs.push(root)
  const runner = join(root, '.holo-js/framework/run.mjs')
  await mkdir(dirname(runner), { recursive: true })
  await writeFile(runner, renderFrameworkRunner(framework))
  await writeFile(join(dirname(runner), 'project.json'), JSON.stringify(framework))
  const entry = join(root, mode === 'dev' ? `node_modules/.bin/${framework.binary}` : framework.entry)
  await mkdir(dirname(entry), { recursive: true })
  await writeFile(entry, [
    '#!/usr/bin/env node',
    'console.log(JSON.stringify({ args: process.argv.slice(2), port: process.env.PORT, nitroPort: process.env.NITRO_PORT }))',
  ].join('\n'))
  await chmod(entry, 0o755)
  return runner
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
        await runProjectDevServer(io, root, undefined, () => watch(root, () => {}), async () => {}, args)
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
