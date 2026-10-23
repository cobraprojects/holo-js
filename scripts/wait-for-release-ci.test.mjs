import assert from 'node:assert/strict'
import { test } from 'node:test'
import { requiredCiWorkflows, summarizeCiRuns, waitForReleaseCi } from './wait-for-release-ci.mjs'

const sha = 'a'.repeat(40)

function run(overrides = {}) {
  return {
    id: 1,
    name: 'Quality gates',
    head_sha: sha,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  }
}

function allSucceeded(overrides = {}) {
  return requiredCiWorkflows.map((name, index) => run({ id: index + 1, name, ...overrides }))
}

test('the release gate requires every CI workflow that guards main', () => {
  assert.deepEqual(requiredCiWorkflows, [
    'Quality gates',
    'Library tests',
    'Node platform compatibility',
    'App and acceptance suites',
  ])
})

test('the release gate succeeds once every required workflow passed on the push to this commit', () => {
  assert.deepEqual(summarizeCiRuns(allSucceeded(), sha), { state: 'success', details: [] })
})

test('the release gate waits while a required workflow has not run for this commit yet', () => {
  const runs = allSucceeded().filter(entry => entry.name !== 'Library tests')

  assert.deepEqual(summarizeCiRuns(runs, sha), {
    state: 'pending',
    details: ['Library tests: no push run for this commit yet'],
  })
})

test('the release gate waits while a required workflow is still running', () => {
  const runs = allSucceeded().map(entry => entry.name === 'Library tests'
    ? { ...entry, status: 'in_progress', conclusion: null }
    : entry)

  assert.deepEqual(summarizeCiRuns(runs, sha), {
    state: 'pending',
    details: ['Library tests: in_progress'],
  })
})

test('the release gate fails when a required workflow concluded without success', () => {
  const runs = allSucceeded().map(entry => entry.name === 'Node platform compatibility'
    ? { ...entry, conclusion: 'failure' }
    : entry)

  assert.deepEqual(summarizeCiRuns(runs, sha), {
    state: 'failed',
    details: ['Node platform compatibility: failure'],
  })
})

test('the release gate treats a cancelled required workflow as a failure', () => {
  const runs = allSucceeded().map(entry => entry.name === 'Quality gates'
    ? { ...entry, conclusion: 'cancelled' }
    : entry)

  assert.deepEqual(summarizeCiRuns(runs, sha), {
    state: 'failed',
    details: ['Quality gates: cancelled'],
  })
})

test('the release gate judges the latest run of a workflow, so a re-run replaces an earlier failure', () => {
  const runs = [
    run({ id: 1, name: 'Library tests', conclusion: 'failure' }),
    ...allSucceeded(),
  ]

  assert.deepEqual(summarizeCiRuns(runs, sha), { state: 'success', details: [] })
})

test('the release gate ignores runs for other commits and runs that are not push runs', () => {
  const runs = [
    ...allSucceeded().filter(entry => entry.name !== 'Quality gates'),
    run({ id: 50, name: 'Quality gates', head_sha: 'b'.repeat(40), conclusion: 'failure' }),
    run({ id: 51, name: 'Quality gates', event: 'pull_request', conclusion: 'failure' }),
  ]

  assert.deepEqual(summarizeCiRuns(runs, sha), {
    state: 'pending',
    details: ['Quality gates: no push run for this commit yet'],
  })
})

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

test('the release gate polls the push runs for this commit until every required workflow passes', async () => {
  const responses = [
    jsonResponse({ total_count: 1, workflow_runs: [run({ name: 'Quality gates', status: 'in_progress', conclusion: null })] }),
    jsonResponse({ total_count: requiredCiWorkflows.length, workflow_runs: allSucceeded() }),
  ]
  const requested = []
  const logs = []

  await waitForReleaseCi({
    repository: 'cobraprojects/holo-js',
    sha,
    token: 'token',
    pollMs: 0,
    log: message => logs.push(message),
    fetchImpl: async (url, init) => {
      requested.push({ url: url.toString(), authorization: init.headers.Authorization })
      return responses.shift()
    },
  })

  assert.equal(requested.length, 2)
  assert.match(requested[0].url, /^https:\/\/api\.github\.com\/repos\/cobraprojects\/holo-js\/actions\/runs\?/)
  assert.ok(requested[0].url.includes(`head_sha=${sha}`))
  assert.ok(requested[0].url.includes('event=push'))
  assert.equal(requested[0].authorization, 'Bearer token')
  assert.deepEqual(logs, [
    `Waiting for CI on ${sha}: Quality gates: in_progress; Library tests: no push run for this commit yet; Node platform compatibility: no push run for this commit yet; App and acceptance suites: no push run for this commit yet`,
    `CI passed for ${sha}; publishing.`,
  ])
})

test('the release gate refuses to publish when a required workflow failed', async () => {
  await assert.rejects(waitForReleaseCi({
    repository: 'cobraprojects/holo-js',
    sha,
    token: 'token',
    pollMs: 0,
    log: () => {},
    fetchImpl: async () => jsonResponse({
      total_count: 1,
      workflow_runs: allSucceeded().map(entry => entry.name === 'Library tests' ? { ...entry, conclusion: 'failure' } : entry),
    }),
  }), /CI did not pass for a{40}, so nothing was published\. Library tests: failure/)
})

test('the release gate fails loudly when the GitHub API refuses the request', async () => {
  await assert.rejects(waitForReleaseCi({
    repository: 'cobraprojects/holo-js',
    sha,
    token: 'token',
    pollMs: 0,
    log: () => {},
    fetchImpl: async () => jsonResponse({ message: 'Forbidden' }, 403),
  }), /GitHub API responded 403 while listing workflow runs/)
})

test('the release gate times out instead of waiting forever for a workflow that never runs', async () => {
  await assert.rejects(waitForReleaseCi({
    repository: 'cobraprojects/holo-js',
    sha,
    token: 'token',
    timeoutMs: 0,
    pollMs: 0,
    log: () => {},
    fetchImpl: async () => jsonResponse({ total_count: 0, workflow_runs: [] }),
  }), /Timed out waiting for CI on a{40}, so nothing was published\./)
})
