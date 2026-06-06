import { spinner } from '@clack/prompts'
import type { IoStreams } from './cli-types'

export function writeLine(stream: NodeJS.WriteStream, message = ''): void {
  stream.write(`${message}\n`)
}

export async function runWithSpinner<TValue>(
  io: IoStreams,
  message: string,
  task: () => Promise<TValue>,
  successMessage = message,
): Promise<TValue> {
  if (!supportsSpinner(io)) {
    return task()
  }

  const loading = spinner({
    input: io.stdin,
    output: io.stdout,
  })

  loading.start(message)

  try {
    const result = await task()
    loading.stop(successMessage)
    return result
  } catch (error) {
    loading.error('Command failed.')
    throw error
  }
}

export function supportsSpinner(io: IoStreams): boolean {
  return io.stdin.isTTY === true
    && io.stdout.isTTY === true
    && typeof io.stdin.setRawMode === 'function'
}
