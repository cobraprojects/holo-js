export async function stopExampleAppProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise(resolve => child.once('close', resolve))
  const kill = signal => {
    try {
      process.kill(-child.pid, signal)
    } catch {
      child.kill(signal)
    }
  }
  kill('SIGTERM')
  let deadline
  try {
    await Promise.race([
      closed,
      new Promise((resolve, reject) => {
        deadline = setTimeout(() => reject(new Error(`Process ${child.spawnargs.join(' ')} did not stop after SIGTERM`)), 10000)
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
