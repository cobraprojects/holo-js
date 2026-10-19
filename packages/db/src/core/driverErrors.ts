const DEADLOCK_DRIVER_CODES: ReadonlySet<string> = new Set(['ER_LOCK_DEADLOCK', '40P01', '40001'])
const MAX_ERROR_CHAIN_DEPTH = 8

export function driverErrorCodes(error: unknown): readonly string[] {
  const codes: string[] = []
  const seen = new Set<object>()
  let current: unknown = error
  for (
    let depth = 0;
    depth < MAX_ERROR_CHAIN_DEPTH && typeof current === 'object' && current !== null && !seen.has(current);
    depth += 1
  ) {
    seen.add(current)
    const code = Reflect.get(current, 'code')
    if (typeof code === 'string') {
      codes.push(code)
    }
    current = Reflect.get(current, 'cause')
  }

  return codes
}

export function isDatabaseDeadlockError(error: unknown): boolean {
  return driverErrorCodes(error).some(code => DEADLOCK_DRIVER_CODES.has(code))
}
