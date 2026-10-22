export interface CommitFailureRestore {
  absorb(later: CommitFailureRestore): void
  restore(): void
}

const restoresByTransaction = new WeakMap<object, Map<object, CommitFailureRestore>>()

export function commitFailureRestoreFor<T extends CommitFailureRestore>(
  transaction: object,
  owner: object,
  create: () => T,
): T {
  const restores = restoresByTransaction.get(transaction) ?? new Map<object, CommitFailureRestore>()
  restoresByTransaction.set(transaction, restores)

  const existing = restores.get(owner)
  if (existing) {
    return existing as T
  }

  const restore = create()
  restores.set(owner, restore)
  return restore
}

export function moveCommitFailureRestores(from: object, to: object): void {
  const restores = restoresByTransaction.get(from)
  if (!restores) {
    return
  }

  restoresByTransaction.delete(from)
  const target = restoresByTransaction.get(to) ?? new Map<object, CommitFailureRestore>()
  restoresByTransaction.set(to, target)
  for (const [owner, later] of restores) {
    const earlier = target.get(owner)
    if (earlier) {
      earlier.absorb(later)
    } else {
      target.set(owner, later)
    }
  }
}

export function runCommitFailureRestores(transaction: object): void {
  const restores = restoresByTransaction.get(transaction)
  if (!restores) {
    return
  }

  restoresByTransaction.delete(transaction)
  for (const restore of restores.values()) {
    restore.restore()
  }
}

export function discardCommitFailureRestores(transaction: object): void {
  restoresByTransaction.delete(transaction)
}
