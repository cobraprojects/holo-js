import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runWithSpinner, supportsSpinner } from '../src/io'
import type { IoStreams } from '../src/cli-types'

const spinnerMock = vi.hoisted(() => ({
  error: vi.fn(),
  spinner: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}))

vi.mock('@clack/prompts', () => ({
  spinner: spinnerMock.spinner,
}))

type TestReadStream = PassThrough & NodeJS.ReadStream & {
  isTTY?: boolean
  setRawMode?: (mode: boolean) => TestReadStream
}

type TestWriteStream = PassThrough & NodeJS.WriteStream & {
  isTTY?: boolean
}

function createIo(options: { readonly tty?: boolean, readonly rawMode?: boolean } = {}): IoStreams {
  const stdin = new PassThrough() as TestReadStream
  const stdout = new PassThrough() as TestWriteStream
  const stderr = new PassThrough() as TestWriteStream
  stdin.isTTY = options.tty === true
  stdout.isTTY = options.tty === true
  stderr.isTTY = options.tty === true

  if (options.rawMode) {
    stdin.setRawMode = () => stdin
  }

  return {
    cwd: '/tmp',
    stdin,
    stdout,
    stderr,
  }
}

describe('CLI IO', () => {
  beforeEach(() => {
    spinnerMock.error.mockReset()
    spinnerMock.spinner.mockReset()
    spinnerMock.start.mockReset()
    spinnerMock.stop.mockReset()
  })

  it('runs tasks without a spinner outside a real terminal', async () => {
    const io = createIo({ tty: true })

    await expect(runWithSpinner(io, 'Loading...', async () => 'done')).resolves.toBe('done')

    expect(supportsSpinner(io)).toBe(false)
    expect(spinnerMock.spinner).not.toHaveBeenCalled()
  })

  it('starts and stops the spinner for real terminal streams', async () => {
    const io = createIo({ tty: true, rawMode: true })

    spinnerMock.spinner.mockReturnValueOnce({
      error: spinnerMock.error,
      isCancelled: false,
      start: spinnerMock.start,
      stop: spinnerMock.stop,
      cancel: vi.fn(),
      clear: vi.fn(),
      message: vi.fn(),
    })

    await expect(runWithSpinner(io, 'Installing...', async () => 1, 'Installed.')).resolves.toBe(1)

    expect(supportsSpinner(io)).toBe(true)
    expect(spinnerMock.spinner).toHaveBeenCalledWith({
      input: io.stdin,
      output: io.stdout,
    })
    expect(spinnerMock.start).toHaveBeenCalledWith('Installing...')
    expect(spinnerMock.stop).toHaveBeenCalledWith('Installed.')
  })

  it('marks the spinner as failed before rethrowing task errors', async () => {
    const io = createIo({ tty: true, rawMode: true })
    const error = new Error('install failed')

    spinnerMock.spinner.mockReturnValueOnce({
      error: spinnerMock.error,
      isCancelled: false,
      start: spinnerMock.start,
      stop: spinnerMock.stop,
      cancel: vi.fn(),
      clear: vi.fn(),
      message: vi.fn(),
    })

    await expect(runWithSpinner(io, 'Installing...', async () => {
      throw error
    })).rejects.toThrow(error)

    expect(spinnerMock.error).toHaveBeenCalledWith('Command failed.')
  })
})
