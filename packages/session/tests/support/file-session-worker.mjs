import { mkdir, utimes } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const [mode, root, sessionId, parameter, driverEntry] = process.argv.slice(2)
if (!driverEntry) throw new Error('Expected the current session package build')
const { createFileSessionStore, fileSessionDriverInternals } = await import(pathToFileURL(driverEntry).href)
if (mode === 'hold') {
  const release = await fileSessionDriverInternals.acquireRecordLock(fileSessionDriverInternals.getRecordPath(root, sessionId), mkdir)
  const stale = new Date(Date.now() - 20_000)
  await utimes(parameter, stale, stale)
  process.on('message', async message => {
    if (message === 'release') {
      await release()
      process.disconnect()
    }
  })
} else {
  const store = createFileSessionStore(root)
  process.on('message', async message => {
    if (message !== 'start') return
    try {
      for (let index = 0; index < 5; index += 1) {
        await store.flash(sessionId, `${parameter}.${index}`, { writer: parameter, index })
      }
      process.send({ event: 'done' })
      process.disconnect()
    } catch (error) {
      process.send({ event: 'failed', message: error.message })
      process.disconnect()
      process.exitCode = 1
    }
  })
}
process.send({ event: 'ready' })
