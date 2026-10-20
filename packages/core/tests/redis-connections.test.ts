import { describe, expect, it } from 'vitest'
import { createManagedRedisConnections } from '../src/portable/redisConnections'

function createRecordingAdapters(closed: string[]) {
  return (name: string) => ({
    name,
    async close() {
      closed.push(name)
    },
  })
}

describe('managed Redis connections', () => {
  it('closes each connection exactly once at disposal, including one that was retained and revived', async () => {
    const closed: string[] = []
    const createAdapter = createRecordingAdapters(closed)
    const connections = createManagedRedisConnections<string, ReturnType<typeof createAdapter>>()

    await connections.acquire('a', () => createAdapter('a'))
    connections.commit()
    await connections.acquire('b', () => createAdapter('b'))
    connections.commit()
    await connections.acquire('a', () => createAdapter('a-again'))
    connections.commit()
    await connections.dispose()

    expect(closed.sort()).toEqual(['a', 'b'])
  })

  it('keeps a revived retained connection open for disposal when the pass that revived it is discarded', async () => {
    const closed: string[] = []
    const createAdapter = createRecordingAdapters(closed)
    const connections = createManagedRedisConnections<string, ReturnType<typeof createAdapter>>()

    await connections.acquire('a', () => createAdapter('a'))
    connections.commit()
    await connections.acquire('b', () => createAdapter('b'))
    connections.commit()
    await connections.acquire('a', () => createAdapter('a-again'))
    await connections.discard()
    await connections.dispose()

    expect(closed.sort()).toEqual(['a', 'b'])
  })
})
