import { mkdir, readdir, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [root, sessionId, driverEntry] = process.argv.slice(2)
if (!driverEntry) throw new Error('Expected the current session package build')
const { fileSessionDriverInternals } = await import(pathToFileURL(driverEntry).href)
const recordPath = fileSessionDriverInternals.getRecordPath(root, sessionId)
await fileSessionDriverInternals.acquireRecordLock(recordPath, mkdir)
const lockPath = `${recordPath}.lock`
const aged = new Date(Date.now() - 20_000)
for (const name of await readdir(lockPath)) await utimes(join(lockPath, name), aged, aged)
await utimes(lockPath, aged, aged)
process.on('message', () => undefined)
process.send({ event: 'locked' })
