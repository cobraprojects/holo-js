import { existsSync, watch } from 'node:fs'
import { join, sep } from 'node:path'

const ignoredSegments = new Set(['node_modules', '.next'])
const runtimeSegments = new Set(['storage', '.holo-js'])
const windowMs = 5000

function formatEvent(event) {
  return `${new Date(event.at).toISOString()} ${event.change.padEnd(8)} ${event.file}`
}

function startWatcher(directory, events) {
  const recordError = error => events.push({ at: Date.now(), change: 'error', file: `file watching stopped: ${error.message}` })
  try {
    const watcher = watch(directory, { recursive: true }, (type, file) => {
      if (!file || file.split(sep).some(segment => ignoredSegments.has(segment))) return
      const change = type === 'change' ? 'modified' : existsSync(join(directory, file)) ? 'created' : 'deleted'
      events.push({ at: Date.now(), change, file })
    })
    watcher.on('error', recordError)
    return watcher
  } catch (error) {
    recordError(error)
    return undefined
  }
}

export function watchExampleAppFiles(directory) {
  const events = []
  const watcher = startWatcher(directory, events)

  return {
    close() {
      watcher?.close()
    },
    log() {
      return `${events.map(formatEvent).join('\n')}\n`
    },
    hasSourceEditBefore(at) {
      return events.some(event => event.at <= at && event.at > at - windowMs && event.change !== 'error'
        && !event.file.split(sep).some(segment => runtimeSegments.has(segment)))
    },
    before(times) {
      return times.map(at => [
        `File changes in the ${windowMs / 1000}s before ${new Date(at).toISOString()}:`,
        ...events.filter(event => event.at <= at && event.at > at - windowMs).map(formatEvent),
      ].join('\n')).join('\n\n')
    },
  }
}
