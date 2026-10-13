import { setTimeout as delay } from 'node:timers/promises'

export async function stopExampleAppProcess(child, signal = 'SIGTERM') {
  if (!child) return
  const closed = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise(resolve => child.once('close', resolve))
  const kill = signal => {
    try {
      process.kill(-child.pid, signal)
    } catch {
      child.kill(signal)
    }
  }
  kill(signal)
  let deadline
  try {
    await Promise.race([
      (async () => {
        await closed
        if (process.platform === 'win32') return
        while (true) {
          try {
            process.kill(-child.pid, 0)
          } catch {
            return
          }
          await delay(25)
        }
      })(),
      new Promise((resolve, reject) => {
        deadline = setTimeout(() => reject(new Error(`Process ${child.spawnargs.join(' ')} did not stop after ${signal}`)), 10000)
      }),
    ])
  } catch (error) {
    kill('SIGKILL')
    await closed
    throw error
  } finally {
    clearTimeout(deadline)
  }
}
