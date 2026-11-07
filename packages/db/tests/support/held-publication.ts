import type { DatabaseQueryCacheBridge } from '../../src'

export function createHeldPublicationBridge() {
  let hold: { reached: () => void, release: Promise<void> } | undefined
  const bridge: DatabaseQueryCacheBridge = {
    async get() { return null },
    async put() {},
    async flexible(_key, _ttl, callback) { return await callback() },
    async forget() { return false },
    async invalidateDependencies() {
      const current = hold
      hold = undefined
      if (current) {
        current.reached()
        await current.release
      }
    },
  }

  const holdNextPublication = () => {
    let reached!: () => void
    let release!: () => void
    const reachedPromise = new Promise<void>((resolve) => { reached = resolve })
    hold = { reached, release: new Promise<void>((resolve) => { release = resolve }) }
    return { reached: reachedPromise, release }
  }

  const heldWrite = async (write: () => Promise<unknown>) => {
    const held = holdNextPublication()
    const pending = write()
    await Promise.race([
      held.reached,
      pending.then(() => { throw new Error('The held write finished without publishing.') }),
    ])
    return async () => {
      held.release()
      await pending
    }
  }

  return { bridge, heldWrite }
}
