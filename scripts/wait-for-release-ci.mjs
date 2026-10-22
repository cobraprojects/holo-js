import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

export const requiredCiWorkflows = [
  'Quality gates',
  'Library tests',
  'Node platform compatibility',
  'App and acceptance suites',
]

const runsPageSize = 100
const releaseWaitTimeoutMs = 100 * 60_000
const releasePollIntervalMs = 30_000

export function summarizeCiRuns(runs, sha, workflows = requiredCiWorkflows) {
  const latestByWorkflow = new Map()
  for (const entry of runs) {
    if (entry.head_sha !== sha || entry.event !== 'push') continue
    const current = latestByWorkflow.get(entry.name)
    if (!current || entry.id > current.id) latestByWorkflow.set(entry.name, entry)
  }

  const failed = []
  const pending = []
  for (const name of workflows) {
    const entry = latestByWorkflow.get(name)
    if (!entry) {
      pending.push(`${name}: no push run for this commit yet`)
    } else if (entry.status !== 'completed') {
      pending.push(`${name}: ${entry.status}`)
    } else if (entry.conclusion !== 'success') {
      failed.push(`${name}: ${entry.conclusion}`)
    }
  }

  if (failed.length > 0) return { state: 'failed', details: failed }
  if (pending.length > 0) return { state: 'pending', details: pending }
  return { state: 'success', details: [] }
}

async function listPushRuns({ repository, sha, token, fetchImpl }) {
  const runs = []
  for (let page = 1; ; page += 1) {
    const url = new URL(`https://api.github.com/repos/${repository}/actions/runs`)
    url.search = new URLSearchParams({
      head_sha: sha,
      event: 'push',
      per_page: String(runsPageSize),
      page: String(page),
    }).toString()
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    if (!response.ok) {
      throw new Error(`GitHub API responded ${response.status} while listing workflow runs for ${sha}.`)
    }
    const body = await response.json()
    runs.push(...body.workflow_runs)
    if (body.workflow_runs.length < runsPageSize || runs.length >= body.total_count) return runs
  }
}

export async function waitForReleaseCi({
  repository,
  sha,
  token,
  fetchImpl = fetch,
  timeoutMs = releaseWaitTimeoutMs,
  pollMs = releasePollIntervalMs,
  log = console.log,
}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const summary = summarizeCiRuns(await listPushRuns({ repository, sha, token, fetchImpl }), sha)
    if (summary.state === 'success') {
      log(`CI passed for ${sha}; publishing.`)
      return
    }
    if (summary.state === 'failed') {
      throw new Error(`CI did not pass for ${sha}, so nothing was published. ${summary.details.join('; ')}`)
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for CI on ${sha}, so nothing was published. ${summary.details.join('; ')}`)
    }
    log(`Waiting for CI on ${sha}: ${summary.details.join('; ')}`)
    await sleep(pollMs)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { GITHUB_REPOSITORY: repository, GITHUB_SHA: sha, GITHUB_TOKEN: token } = process.env
  if (!repository || !sha || !token) {
    console.error('::error title=CI gate::GITHUB_REPOSITORY, GITHUB_SHA and GITHUB_TOKEN must be set.')
    process.exit(1)
  }
  try {
    await waitForReleaseCi({ repository, sha, token })
  } catch (error) {
    console.error(`::error title=Release blocked::${error.message}`)
    process.exit(1)
  }
}
