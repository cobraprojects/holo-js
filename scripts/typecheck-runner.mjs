import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { join, resolve } from 'node:path'

const buildInfoRoot = resolve('node_modules/.cache/holo-typecheck')

export function typecheckConcurrency() {
  const configured = Number.parseInt(process.env.HOLO_TYPECHECK_CONCURRENCY ?? '', 10)
  if (Number.isSafeInteger(configured) && configured > 0) {
    return configured
  }

  return Math.max(1, Math.min(6, availableParallelism() - 1))
}

function buildInfoPath(job) {
  const key = createHash('sha256').update(job.name).digest('hex').slice(0, 16)
  return join(buildInfoRoot, `${key}.tsbuildinfo`)
}

function runJob(job) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      'bunx',
      ['tsc', '-p', job.configPath, '--noEmit', '--incremental', '--tsBuildInfoFile', buildInfoPath(job)],
      {
        stdio: ['inherit', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      },
    )

    let output = ''
    child.stdout.on('data', chunk => {
      output += chunk.toString()
    })
    child.stderr.on('data', chunk => {
      output += chunk.toString()
    })

    child.on('close', code => {
      resolvePromise({ job, output, failed: code !== 0 })
    })
    child.on('error', rejectPromise)
  })
}

export async function runTypecheckJobs(jobs, label) {
  await mkdir(buildInfoRoot, { recursive: true })

  const pending = [...jobs]
  const failures = []
  const workers = Array.from({ length: Math.min(typecheckConcurrency(), pending.length) }, async () => {
    while (pending.length > 0) {
      const job = pending.shift()
      const result = await runJob(job)
      if (result.output.trim()) {
        process.stdout.write(`${result.output.trim()}\n`)
      }
      if (result.failed) {
        failures.push(job.name)
        continue
      }
      process.stdout.write(`✓ ${job.name}\n`)
    }
  })

  await Promise.all(workers)

  if (failures.length > 0) {
    throw new Error(`${label} failed for ${failures.sort().join(', ')}`)
  }
}
