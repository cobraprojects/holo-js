import assert from 'node:assert/strict'
import test from 'node:test'
import { parseShard, selectShardTasks } from './library-suite-shards.mjs'

const tasksOf = (...labels) => labels.map(label => ({ label }))
const labelsOf = tasks => tasks.map(task => task.label)

test('runs every task in exactly one shard', () => {
  const tasks = tasksOf('packages/a', 'packages/b', 'packages/c', 'packages/d', 'packages/e')
  const durations = { 'packages/a': 50, 'packages/b': 40, 'packages/c': 30, 'packages/d': 20, 'packages/e': 10 }
  const shards = [1, 2, 3].map(index => labelsOf(selectShardTasks(tasks, { index, total: 3 }, durations)))
  assert.deepEqual(shards.flat().sort(), labelsOf(tasks))
})

test('balances shards by measured duration and keeps the suite order inside a shard', () => {
  const tasks = tasksOf('packages/cli', 'packages/core', 'packages/db', 'packages/kernel')
  const durations = { 'packages/cli': 100, 'packages/core': 90, 'packages/db': 15, 'packages/kernel': 5 }
  assert.deepEqual(labelsOf(selectShardTasks(tasks, { index: 1, total: 2 }, durations)), ['packages/cli', 'packages/kernel'])
  assert.deepEqual(labelsOf(selectShardTasks(tasks, { index: 2, total: 2 }, durations)), ['packages/core', 'packages/db'])
})

test('still runs packages that have no measured duration yet', () => {
  const tasks = tasksOf('packages/known', 'packages/new')
  const shards = [1, 2].map(index => labelsOf(selectShardTasks(tasks, { index, total: 2 }, { 'packages/known': 10 })))
  assert.deepEqual(shards.flat().sort(), ['packages/known', 'packages/new'])
})

test('rejects malformed or out-of-range shards', () => {
  assert.deepEqual(parseShard('2/3'), { index: 2, total: 3 })
  for (const value of ['0/3', '4/3', '1', 'a/b', '1/0']) assert.throws(() => parseShard(value), /Invalid shard/)
})

test('rejects more shards than there are tasks', () => {
  assert.throws(() => selectShardTasks(tasksOf('packages/a'), { index: 1, total: 1000000000 }, {}), /Cannot split 1 tasks into 1000000000 shards/)
})
