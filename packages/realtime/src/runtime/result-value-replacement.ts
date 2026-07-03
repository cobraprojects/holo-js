import type {
  RealtimePatchPathSegment,
} from './result-path'
import { isRecord } from './value'

export function replaceValueAtPath(
  value: unknown,
  path: readonly RealtimePatchPathSegment[],
  replacement: unknown,
): unknown {
  const segment = path[0]
  if (typeof segment === 'undefined') {
    return replacement
  }

  if (path.length === 1) {
    if (Array.isArray(value) && typeof segment === 'number') {
      if (!Number.isInteger(segment) || segment < 0 || segment >= value.length) {
        return value
      }

      if (value[segment] === replacement) {
        return value
      }

      return Object.freeze(copyArrayWithReplacement(value, segment, replacement))
    }

    if (isRecord(value) && typeof segment === 'string') {
      if (value[segment] === replacement) {
        return value
      }

      return Object.freeze(copyRecordWithReplacement(value, segment, replacement))
    }

    return value
  }

  return replaceValueAtPathIndex(value, path, 0, replacement)
}

export function copyArrayWithReplacement(
  value: readonly unknown[],
  index: number,
  replacement: unknown,
): unknown[] {
  const length = value.length
  const nextValue = new Array<unknown>(length)
  for (let currentIndex = 0; currentIndex < length; currentIndex += 1) {
    nextValue[currentIndex] = currentIndex === index ? replacement : value[currentIndex]
  }

  return nextValue
}

export function copyRecordWithReplacement(
  value: Readonly<Record<string, unknown>>,
  key: string,
  replacement: unknown,
): Record<string, unknown> {
  const nextValue: Record<string, unknown> = {}
  for (const currentKey of Object.keys(value)) {
    nextValue[currentKey] = currentKey === key ? replacement : value[currentKey]
  }

  if (!Object.prototype.propertyIsEnumerable.call(value, key)) {
    nextValue[key] = replacement
  }

  return nextValue
}

function replaceValueAtPathIndex(
  value: unknown,
  path: readonly RealtimePatchPathSegment[],
  index: number,
  replacement: unknown,
): unknown {
  const segment = path[index]
  if (typeof segment === 'undefined') {
    return replacement
  }

  if (Array.isArray(value) && typeof segment === 'number') {
    if (!Number.isInteger(segment) || segment < 0 || segment >= value.length) {
      return value
    }

    const nextChild = replaceValueAtPathIndex(value[segment], path, index + 1, replacement)
    if (nextChild === value[segment]) {
      return value
    }

    return Object.freeze(copyArrayWithReplacement(value, segment, nextChild))
  }

  if (isRecord(value) && typeof segment === 'string') {
    const nextChild = replaceValueAtPathIndex(value[segment], path, index + 1, replacement)
    if (nextChild === value[segment]) {
      return value
    }

    return Object.freeze(copyRecordWithReplacement(value, segment, nextChild))
  }

  return value
}
