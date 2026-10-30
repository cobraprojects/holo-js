import type * as childProcess from 'node:child_process'
import { createServer, type Socket } from 'node:net'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { startRedisService } from '../../session/tests/support/redis'

const harness = vi.hoisted(() => ({
  spawned: [] as string[][],
  beforeSpawn: undefined as ((args: readonly string[]) => Promise<void> | undefined) | undefined,
}))

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof childProcess>()
  return {
    ...actual,
    spawn: (command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
      harness.spawned.push([...args])
      const occupied = harness.beforeSpawn?.(args)
      if (!occupied) return actual.spawn(command, args, options)
      const child = actual.spawn('/bin/sh', ['-c', 'read _; exec "$@"', 'redis-gate', command, ...args], { ...options, stdio: ['pipe', 'pipe', 'pipe'] })
      occupied.then(() => child.stdin?.end('\n'), () => child.kill())
      return child
    },
  }
})

function valueOf(args: readonly string[], flag: string): number {
  const index = args.indexOf(flag)
  const value = Number(args[index + 1])
  if (index < 0 || !Number.isInteger(value)) throw new Error(`Expected ${flag} in Redis arguments`)
  return value
}

function occupyFirstNodePort(flag: '--port' | '--cluster-port'): { readonly port: () => number | undefined } {
  let occupied: number | undefined
  harness.beforeSpawn = args => {
    if (occupied !== undefined || !args.includes(flag)) return undefined
    occupied = valueOf(args, flag)
    const port = occupied
    const sockets: Socket[] = []
    const server = createServer(socket => sockets.push(socket))
    onTestFinished(() => new Promise<void>(resolve => {
      server.close(() => resolve())
      for (const socket of sockets) socket.destroy()
    }))
    return new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => resolve())
    })
  }
  onTestFinished(() => { harness.beforeSpawn = undefined })
  return { port: () => occupied }
}

describe('Redis test harness port reservations', () => {
  it('starts every cluster node when its cluster bus port is taken before Redis binds', async () => {
    harness.spawned.length = 0
    const occupant = occupyFirstNodePort('--cluster-port')
    const service = await startRedisService({ cluster: true })
    const occupiedBusPort = occupant.port()
    expect(occupiedBusPort).toBeDefined()
    expect(service.ports).toHaveLength(3)
    for (const args of harness.spawned) {
      expect(valueOf(args, '--cluster-port')).toBe(valueOf(args, '--port') + 10_000)
    }
    expect(harness.spawned.some(args => valueOf(args, '--cluster-port') === occupiedBusPort)).toBe(true)
  }, 30_000)

  it('starts a node when its client port is taken before Redis binds', async () => {
    harness.spawned.length = 0
    const occupant = occupyFirstNodePort('--port')
    const service = await startRedisService()
    expect(occupant.port()).toBeDefined()
    expect(service.ports).not.toContain(occupant.port())
    expect(harness.spawned.some(args => valueOf(args, '--port') === occupant.port())).toBe(true)
  }, 30_000)
})
