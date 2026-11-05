const DECIMAL_TEXT = /^(-?)0*(\d*?)(?:\.(\d*?)0*)?$/

type DecimalParts = { readonly negative: boolean, readonly integer: string, readonly fraction: string }

function readDecimalParts(value: string): DecimalParts | undefined {
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) return undefined
  const [, sign = '', integer = '', fraction = ''] = DECIMAL_TEXT.exec(value)!
  return { negative: sign === '-' && (integer !== '' || fraction !== ''), integer, fraction }
}

function compareMagnitudes(left: DecimalParts, right: DecimalParts): number {
  if (left.integer.length !== right.integer.length) return left.integer.length < right.integer.length ? -1 : 1
  if (left.integer !== right.integer) return left.integer < right.integer ? -1 : 1
  const length = Math.max(left.fraction.length, right.fraction.length)
  const leftFraction = left.fraction.padEnd(length, '0')
  const rightFraction = right.fraction.padEnd(length, '0')
  return leftFraction === rightFraction ? 0 : leftFraction < rightFraction ? -1 : 1
}

function compareDecimalText(a: string, b: string): number | undefined {
  const left = readDecimalParts(a)
  const right = readDecimalParts(b)
  if (!left || !right) return undefined
  if (left.negative !== right.negative) return left.negative ? -1 : 1
  const magnitude = compareMagnitudes(left, right)
  return left.negative ? -magnitude : magnitude
}

function compareValues(a: NonNullable<unknown>, b: NonNullable<unknown>, decimal: boolean): number {
  const comparison = decimal && typeof a === 'string' && typeof b === 'string' ? compareDecimalText(a, b) : undefined
  if (comparison !== undefined) return comparison
  return a < b ? -1 : 1
}

export function compareChunkValuesAscending(a: unknown, b: unknown, decimal = false): number {
  if (a === b) return 0
  if (typeof a === 'undefined' || a === null) return -1
  if (typeof b === 'undefined' || b === null) return 1
  return compareValues(a, b, decimal)
}

export function compareChunkValuesDescending(a: unknown, b: unknown, decimal = false): number {
  if (a === b) return 0
  if (typeof a === 'undefined' || a === null) return 1
  if (typeof b === 'undefined' || b === null) return -1
  return -compareValues(a, b, decimal)
}
