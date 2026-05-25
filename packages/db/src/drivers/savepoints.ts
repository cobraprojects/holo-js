import { TransactionError } from '../core/errors'

const SAVEPOINT_NAME_PATTERN = /^[A-Z_]\w*$/i

export function normalizeSavepointName(name: string): string {
  if (!SAVEPOINT_NAME_PATTERN.test(name)) {
    throw new TransactionError(`Invalid savepoint name "${name}".`)
  }

  return name
}
