import type { TransactionCallback } from './types'

type AfterCommitPublication = () => Promise<TransactionCallback>

const publicationsByCallback = new WeakMap<TransactionCallback, AfterCommitPublication>()

export function createAfterCommitPublication(evict: AfterCommitPublication): TransactionCallback {
  const callback = async (): Promise<void> => {
    const notify = await evict()
    await notify()
  }
  publicationsByCallback.set(callback, evict)
  return callback
}

export async function runAfterCommitCallbacks(callbacks: readonly TransactionCallback[]): Promise<void> {
  const publications: AfterCommitPublication[] = []
  const userCallbacks: TransactionCallback[] = []
  for (const callback of callbacks) {
    const publication = publicationsByCallback.get(callback)
    if (publication) publications.push(publication)
    else userCallbacks.push(callback)
  }

  const notifications: TransactionCallback[] = []
  for (const evict of publications) notifications.push(await evict())
  const deliveries = await Promise.allSettled(notifications.map(async notify => notify()))
  for (const delivery of deliveries) {
    if (delivery.status === 'rejected') throw delivery.reason
  }
  for (const callback of userCallbacks) await callback()
}
