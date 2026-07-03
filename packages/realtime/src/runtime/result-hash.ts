import { stableStringify } from './stable-stringify'

export function createResultHash(value: unknown): string {
  return stableStringify(value)
}
