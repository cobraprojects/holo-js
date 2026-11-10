import type { TransactionCallback } from './types'

export type AfterCommitPublication = (deliveries: Promise<void>[]) => Promise<void>

const publicationsByCallback = new WeakMap<TransactionCallback, AfterCommitPublication>()

export function createAfterCommitPublication(publish: AfterCommitPublication): TransactionCallback {
  const callback = async (): Promise<void> => {
    const deliveries: Promise<void>[] = []
    try {
      await publish(deliveries)
    } finally {
      await Promise.all(deliveries)
    }
  }
  publicationsByCallback.set(callback, publish)
  return callback
}

export function readAfterCommitPublication(callback: TransactionCallback): AfterCommitPublication | undefined {
  return publicationsByCallback.get(callback)
}
