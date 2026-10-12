import { PassThrough } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'
import { describe, expect, it } from 'vitest'
import { runWithSpinner, supportsSpinner } from '../src/io'
import type { IoStreams } from '../src/cli-types'

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
  it('writes task progress and results without a terminal spinner', async () => {
    const io = createIo({ tty: true })
    await expect(runWithSpinner(io, 'Loading...', async () => 'done', 'Loaded.')).resolves.toBe('done')
    expect(supportsSpinner(io)).toBe(false)
    expect(io.stdout.read(io.stdout.readableLength)?.toString()).toBe('Loading...\nLoaded.\n')
  })

  it('renders task completion through the real spinner', async () => {
    const io = createIo({ tty: true, rawMode: true })
    await expect(runWithSpinner(io, 'Installing...', async () => 1, 'Installed.')).resolves.toBe(1)
    expect(supportsSpinner(io)).toBe(true)
    const output = io.stdout.read(io.stdout.readableLength)?.toString() ?? ''
    expect(stripVTControlCharacters(output)).toContain('Installed.')
  })

  it('renders failure through the real spinner and preserves the task error', async () => {
    const io = createIo({ tty: true, rawMode: true })
    const error = new Error('install failed')
    await expect(runWithSpinner(io, 'Installing...', async () => {
      throw error
    })).rejects.toThrow(error)
    const output = io.stdout.read(io.stdout.readableLength)?.toString() ?? ''
    expect(stripVTControlCharacters(output)).toContain('Command failed.')
  })
})
