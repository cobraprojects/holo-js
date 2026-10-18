import { reportError } from '@holo-js/kernel/error-reporting'

export function report(error: unknown): void {
  reportError(error, { capability: 'app', operation: 'report' })
}
