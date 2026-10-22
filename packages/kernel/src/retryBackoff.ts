export function resolveRetryBackoffSeconds(backoff: number | readonly number[], attempt: number): number {
  if (typeof backoff === 'number') {
    return backoff
  }

  return backoff[Math.min(Math.max(attempt - 1, 0), backoff.length - 1)] ?? 0
}
