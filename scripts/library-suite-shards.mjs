import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function readLibrarySuiteDurations(rootDir) {
  return JSON.parse(readFileSync(join(rootDir, 'scripts/library-suite-durations.json'), 'utf8'))
}

export function parseShard(value) {
  const match = /^(\d+)\/(\d+)$/.exec(value)
  const index = Number(match?.[1])
  const total = Number(match?.[2])
  if (!match || index < 1 || index > total) {
    throw new Error(`Invalid shard "${value}". Use <index>/<total>, for example 1/3.`)
  }
  return { index, total }
}

function medianOf(values) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] ?? 1
}

export function selectShardTasks(tasks, { index, total }, durations) {
  const fallbackSeconds = medianOf(Object.values(durations))
  const secondsOf = task => durations[task.label] ?? fallbackSeconds
  const shards = Array.from({ length: total }, () => ({ labels: new Set(), seconds: 0 }))
  const heaviestFirst = [...tasks].sort((left, right) => secondsOf(right) - secondsOf(left) || left.label.localeCompare(right.label))
  for (const task of heaviestFirst) {
    const lightest = shards.reduce((current, shard) => shard.seconds < current.seconds ? shard : current)
    lightest.labels.add(task.label)
    lightest.seconds += secondsOf(task)
  }
  const selected = shards[index - 1].labels
  return tasks.filter(task => selected.has(task.label))
}
