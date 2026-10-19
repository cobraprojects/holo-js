import { describe, expect, it } from 'vitest'
import { buildQueueWorkArgs, runQueueWorkCommand } from '../src/queue'
import { parseBackoffFlag } from '../src/parsing'
import type { IoStreams } from '../src/cli-types'

function createIo(): IoStreams {
  const write = () => true
  return {
    cwd: process.cwd(),
    stdin: process.stdin,
    stdout: { write } as unknown as NodeJS.WriteStream,
    stderr: { write } as unknown as NodeJS.WriteStream,
  }
}

describe('queue:work --backoff', () => {
  it('parses one retry delay or a comma-separated list of retry delays', () => {
    expect(parseBackoffFlag({ backoff: '5' })).toBe(5)
    expect(parseBackoffFlag({ backoff: '5, 10,30' })).toEqual([5, 10, 30])
    expect(parseBackoffFlag({})).toBeUndefined()
  })

  it('rejects a --backoff flag with no operand instead of treating it as absent', () => {
    expect(() => parseBackoffFlag({ backoff: true }))
      .toThrow('Flag "--backoff" requires a value.')
    expect(() => parseBackoffFlag({ backoff: [] }))
      .toThrow('Flag "--backoff" requires a value.')
    expect(parseBackoffFlag({})).toBeUndefined()
  })

  it('rejects a retry delay that is not a non-negative integer', () => {
    expect(() => parseBackoffFlag({ backoff: '5,x' }))
      .toThrow('Flag "--backoff" must be a non-negative integer or a comma-separated list of them.')
    expect(() => parseBackoffFlag({ backoff: '-1' }))
      .toThrow('Flag "--backoff" must be a non-negative integer or a comma-separated list of them.')
  })

  it('forwards the backoff list to queue:listen worker processes', () => {
    expect(buildQueueWorkArgs({ tries: '2', backoff: '5,10' })).toEqual(['queue:work', '--tries', '2', '--backoff', '5,10'])
  })

  it('passes the parsed backoff to the queue worker', async () => {
    const received: unknown[] = []
    await runQueueWorkCommand(createIo(), process.cwd(), { once: true, backoff: [5, 10], tries: 2 }, {
      getEnvironment: async () => ({ cleanup: async () => {} }) as never,
      runWorker: async options => {
        received.push({ backoff: options.backoff, tries: options.tries })
        return { processed: 0, released: 0, failed: 0, stoppedBecause: 'once' }
      },
    })
    expect(received).toEqual([{ backoff: [5, 10], tries: 2 }])
  })
})
