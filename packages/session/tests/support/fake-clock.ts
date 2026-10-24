import { vi } from 'vitest'

const POLL_STEP_MS = 5

export function fakeTimersPromises() {
  return {
    setTimeout: async <T>(delayMs: number, value?: T): Promise<T | undefined> => await new Promise(resolve => globalThis.setTimeout(() => resolve(value), delayMs)),
  }
}

export function useFakeClock(): void {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
}

export async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

export async function advanceTo(time: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(Math.max(0, time - Date.now()))
}

export async function advanceUntil(condition: () => boolean, description: string, limitMs: number): Promise<void> {
  const deadline = Date.now() + limitMs
  await settle()
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Still waiting for ${description} after ${limitMs}ms on the fake clock`)
    await vi.advanceTimersByTimeAsync(Math.min(POLL_STEP_MS, deadline - Date.now()))
  }
}

export async function finishesWithoutTheClock<T>(operation: Promise<T>, description: string): Promise<T> {
  let done = false
  const running = operation.finally(() => { done = true })
  await settle()
  if (!done) throw new Error(`${description} should finish without waiting on the clock`)
  return await running
}
