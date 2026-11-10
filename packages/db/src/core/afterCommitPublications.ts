import type { TransactionCallback } from './types'

type AfterCommitPublication = {
  readonly evict: () => Promise<void>
  readonly notify: () => Promise<void>
}

const publicationsByCallback = new WeakMap<TransactionCallback, AfterCommitPublication>()

export function createAfterCommitPublication(publication: AfterCommitPublication): TransactionCallback {
  const callback = async (): Promise<void> => {
    await publication.evict()
    await publication.notify()
  }
  publicationsByCallback.set(callback, publication)
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

  for (const publication of publications) await publication.evict()
  const deliveries = await Promise.allSettled(publications.map(async publication => publication.notify()))
  for (const delivery of deliveries) {
    if (delivery.status === 'rejected') throw delivery.reason
  }
  for (const callback of userCallbacks) await callback()
}
