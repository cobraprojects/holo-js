import type { TransactionCallback } from './types'

export type AfterCommitPublication = {
  readonly evict: () => Promise<void>
  readonly notify: (deliveries: Promise<void>[]) => void
}

const publicationsByCallback = new WeakMap<TransactionCallback, AfterCommitPublication>()

export function createAfterCommitPublication(publication: AfterCommitPublication): TransactionCallback {
  const callback = async (): Promise<void> => {
    const deliveries: Promise<void>[] = []
    try {
      await publication.evict()
      publication.notify(deliveries)
    } finally {
      await Promise.all(deliveries)
    }
  }
  publicationsByCallback.set(callback, publication)
  return callback
}

export function readAfterCommitPublication(callback: TransactionCallback): AfterCommitPublication | undefined {
  return publicationsByCallback.get(callback)
}
