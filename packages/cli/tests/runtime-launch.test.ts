import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRuntimeInvocation, runRuntimeInvocation } from '../src/runtime'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function createTempDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'holo-runtime-launch-'))
  tempDirs.push(dir)
  return dir
}

describe('runtime worker launch', () => {
  it('launches the worker with the running Node executable', () => {
    expect(createRuntimeInvocation('/tmp/holo-runtime-worker.mjs')).toEqual({
      command: process.execPath,
      args: ['/tmp/holo-runtime-worker.mjs'],
    })
    expect(createRuntimeInvocation('/tmp/holo-runtime-worker.ts')).toEqual({
      command: process.execPath,
      args: ['--experimental-strip-types', '/tmp/holo-runtime-worker.ts'],
    })
  })

  it('runs a TypeScript worker through type stripping', async () => {
    const dir = await createTempDirectory()
    const workerPath = join(dir, 'worker.ts')
    await writeFile(workerPath, 'const value: number = 42\nprocess.stdout.write(String(value))\n')
    const invocation = createRuntimeInvocation(workerPath)

    const result = await runRuntimeInvocation(invocation.command, invocation.args, {
      cwd: dir,
      env: process.env,
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('42')
  })

  it('runs the worker when node is not on PATH', async () => {
    const dir = await createTempDirectory()
    const workerPath = join(dir, 'worker.mjs')
    await writeFile(workerPath, 'process.stdout.write("launched")\n')
    const invocation = createRuntimeInvocation(workerPath)

    const result = await runRuntimeInvocation(invocation.command, invocation.args, {
      cwd: dir,
      env: { ...process.env, PATH: '' },
    })

    expect(result.error).toBeNull()
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('launched')
  })

  it('forwards the worker stderr as it arrives and keeps it for failure reporting', async () => {
    const dir = await createTempDirectory()
    const workerPath = join(dir, 'worker.mjs')
    await writeFile(workerPath, 'process.stderr.write("[holo:db] query ok\\n")\nprocess.stdout.write("done")\n')
    const invocation = createRuntimeInvocation(workerPath)
    const forwarded: string[] = []

    const result = await runRuntimeInvocation(invocation.command, invocation.args, {
      cwd: dir,
      env: process.env,
      onStderr: chunk => forwarded.push(chunk),
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('done')
    expect(forwarded.join('')).toBe('[holo:db] query ok\n')
    expect(result.stderr).toBe('[holo:db] query ok\n')
  })
})
