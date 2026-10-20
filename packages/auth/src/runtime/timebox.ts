export const AUTH_TIMEBOX_MILLISECONDS = 200

export type AuthTimebox = {
  returnEarly(): void
}

export async function callTimebox<TResult>(
  callback: (timebox: AuthTimebox) => Promise<TResult>,
  minimumMilliseconds: number,
): Promise<TResult> {
  const startedAt = performance.now()
  let returnsEarly = false
  const timebox: AuthTimebox = {
    returnEarly() {
      returnsEarly = true
    },
  }

  try {
    return await callback(timebox)
  } finally {
    if (!returnsEarly) {
      const remaining = minimumMilliseconds - (performance.now() - startedAt)
      if (remaining > 0) {
        await new Promise<void>(resolve => setTimeout(resolve, remaining))
      }
    }
  }
}
