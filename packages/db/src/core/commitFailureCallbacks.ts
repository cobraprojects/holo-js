type CommitFailureCallback = () => void

const callbacksByTransaction = new WeakMap<object, CommitFailureCallback[]>()

export function onTransactionCommitFailure(transaction: object, callback: CommitFailureCallback): void {
  const callbacks = callbacksByTransaction.get(transaction)
  if (callbacks) {
    callbacks.push(callback)
    return
  }

  callbacksByTransaction.set(transaction, [callback])
}

export function moveCommitFailureCallbacks(from: object, to: object): void {
  const callbacks = callbacksByTransaction.get(from)
  if (!callbacks) {
    return
  }

  callbacksByTransaction.delete(from)
  for (const callback of callbacks) {
    onTransactionCommitFailure(to, callback)
  }
}

export function runCommitFailureCallbacks(transaction: object): void {
  const callbacks = callbacksByTransaction.get(transaction)
  if (!callbacks) {
    return
  }

  callbacksByTransaction.delete(transaction)
  for (let callback = callbacks.pop(); callback; callback = callbacks.pop()) {
    callback()
  }
}

export function discardCommitFailureCallbacks(transaction: object): void {
  callbacksByTransaction.delete(transaction)
}
