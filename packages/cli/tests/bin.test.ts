import { afterEach, describe, expect, it, vi } from 'vitest'

type RunCliContext = {
  cwd: string
  stdin: typeof process.stdin
  stdout: typeof process.stdout
  stderr: typeof process.stderr
}

type RunCli = (args: string[], context: RunCliContext) => Promise<number>

const runCliMock = vi.hoisted(() => vi.fn<RunCli>())

vi.mock('../src/cli', () => ({
  runCli: runCliMock,
}))

const originalArgv = process.argv
const originalExitCode = process.exitCode

afterEach(() => {
  process.argv = originalArgv
  process.exitCode = originalExitCode
  runCliMock.mockReset()
  vi.restoreAllMocks()
})

describe('holo bin', () => {
  it('sets exitCode without forcing process termination', async () => {
    process.argv = ['node', 'holo', 'list']
    runCliMock.mockResolvedValue(7)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
      throw new Error(`exit:${String(code)}`)
    }) as typeof process.exit)
    const modulePath = `../src/bin/holo.ts?run=${Date.now()}`

    await import(modulePath)

    expect(runCliMock).toHaveBeenCalledWith(['list'], {
      cwd: process.cwd(),
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    })
    expect(exitSpy).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(7)
  })
})
