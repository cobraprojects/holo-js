import { isRecord } from './value'

export type RealtimePatchPathSegment = string | number

export const EMPTY_RESULT_PATH: readonly RealtimePatchPathSegment[] = Object.freeze([])
export const EMPTY_RESULT_PATH_KEY = createResultPathKey(EMPTY_RESULT_PATH)

export function createResultPathKey(path: readonly RealtimePatchPathSegment[]): string {
  let result = '['
  for (let index = 0; index < path.length; index += 1) {
    if (index > 0) {
      result += ','
    }

    result += JSON.stringify(path[index])
  }

  return `${result}]`
}

export function copyPatchPath(path: readonly RealtimePatchPathSegment[]): readonly RealtimePatchPathSegment[] {
  if (path.length === 0) {
    return EMPTY_RESULT_PATH
  }

  const copiedPath = new Array<RealtimePatchPathSegment>(path.length)
  for (let index = 0; index < path.length; index += 1) {
    copiedPath[index] = path[index]!
  }

  return Object.freeze(copiedPath)
}

export function getValueAtPath(value: unknown, path: readonly RealtimePatchPathSegment[]): unknown {
  let current = value
  for (const segment of path) {
    if (Array.isArray(current) && typeof segment === 'number') {
      current = current[segment]
      continue
    }

    if (isRecord(current) && typeof segment === 'string') {
      current = current[segment]
      continue
    }

    return undefined
  }

  return current
}
