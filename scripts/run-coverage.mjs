import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const coverageRoot = resolve(process.cwd(), 'coverage')
const totalCoverageDirectory = join(coverageRoot, 'total')

export function discoverCoverageJobs(packageJson) {
  const scripts = packageJson?.scripts
  if (!scripts || typeof scripts !== 'object') {
    return []
  }

  return Object.keys(scripts).flatMap((scriptName) => {
    const match = /^test:(.+):coverage$/.exec(scriptName)
    if (!match) {
      return []
    }

    return [{
      scriptName,
      directoryName: match[1],
    }]
  })
}

async function loadCoverageJobs() {
  const packageJsonPath = resolve(process.cwd(), 'package.json')
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))
  return discoverCoverageJobs(packageJson)
}

function runCoverageScript(scriptName) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('bun', ['run', scriptName], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: process.env,
    })

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }

      reject(new Error(
        signal
          ? `Coverage script "${scriptName}" exited from signal ${signal}.`
          : `Coverage script "${scriptName}" exited with code ${code}.`,
      ))
    })
  })
}

async function cleanupCoverageRoot() {
  await mkdir(coverageRoot, { recursive: true })
  const entries = await readdir(coverageRoot, { withFileTypes: true })

  await Promise.all(entries.map(async (entry) => {
    const targetPath = join(coverageRoot, entry.name)

    if (entry.name === 'total') {
      await rm(targetPath, { recursive: true, force: true })
      return
    }

    if (entry.isDirectory()) {
      return
    }

    await rm(targetPath, { force: true })
  }))
}

function cloneCoverageRecord(record) {
  return JSON.parse(JSON.stringify(record))
}

function mergeCountMaps(existing, incoming) {
  const merged = { ...existing }

  for (const [key, value] of Object.entries(incoming)) {
    merged[key] = Math.max(Number(merged[key] ?? 0), Number(value))
  }

  return merged
}

function mergeBranchMaps(existing, incoming) {
  const merged = { ...existing }

  for (const [key, branchCounts] of Object.entries(incoming)) {
    const previousCounts = Array.isArray(merged[key]) ? merged[key] : []
    merged[key] = branchCounts.map((count, index) => Math.max(Number(previousCounts[index] ?? 0), Number(count)))
  }

  return merged
}

function mergeFileCoverage(existing, incoming) {
  return {
    path: existing.path,
    all: existing.all || incoming.all,
    statementMap: { ...existing.statementMap, ...incoming.statementMap },
    s: mergeCountMaps(existing.s, incoming.s),
    branchMap: { ...existing.branchMap, ...incoming.branchMap },
    b: mergeBranchMaps(existing.b, incoming.b),
    fnMap: { ...existing.fnMap, ...incoming.fnMap },
    f: mergeCountMaps(existing.f, incoming.f),
  }
}

function accumulateLineHits(fileCoverage) {
  const lineHits = new Map()

  for (const [statementId, location] of Object.entries(fileCoverage.statementMap)) {
    const line = location?.start?.line
    if (typeof line !== 'number') {
      continue
    }

    const hits = Number(fileCoverage.s[statementId] ?? 0)
    lineHits.set(line, Math.max(lineHits.get(line) ?? 0, hits))
  }

  return lineHits
}

function createSummary(coverageMap) {
  let coveredStatements = 0
  let totalStatements = 0
  let coveredBranches = 0
  let totalBranches = 0
  let coveredFunctions = 0
  let totalFunctions = 0
  let coveredLines = 0
  let totalLines = 0

  for (const fileCoverage of Object.values(coverageMap)) {
    for (const hits of Object.values(fileCoverage.s)) {
      totalStatements += 1
      if (Number(hits) > 0) {
        coveredStatements += 1
      }
    }

    for (const hits of Object.values(fileCoverage.f)) {
      totalFunctions += 1
      if (Number(hits) > 0) {
        coveredFunctions += 1
      }
    }

    for (const branchHits of Object.values(fileCoverage.b)) {
      for (const hits of branchHits) {
        totalBranches += 1
        if (Number(hits) > 0) {
          coveredBranches += 1
        }
      }
    }

    const lineHits = accumulateLineHits(fileCoverage)
    totalLines += lineHits.size
    coveredLines += [...lineHits.values()].filter(hits => hits > 0).length
  }

  return {
    statements: summarizeCounts(coveredStatements, totalStatements),
    branches: summarizeCounts(coveredBranches, totalBranches),
    functions: summarizeCounts(coveredFunctions, totalFunctions),
    lines: summarizeCounts(coveredLines, totalLines),
  }
}

function summarizeCounts(covered, total) {
  return {
    covered,
    total,
    pct: total === 0 ? 100 : Number(((covered / total) * 100).toFixed(2)),
  }
}

async function mergeCoverageReports(coverageJobs) {
  const mergedCoverage = {}

  for (const job of coverageJobs) {
    const coveragePath = join(coverageRoot, job.directoryName, 'coverage-final.json')
    const rawCoverage = await readFile(coveragePath, 'utf8')
    const coverageMap = JSON.parse(rawCoverage)

    for (const [filePath, fileCoverage] of Object.entries(coverageMap)) {
      if (!mergedCoverage[filePath]) {
        mergedCoverage[filePath] = cloneCoverageRecord(fileCoverage)
        continue
      }

      mergedCoverage[filePath] = mergeFileCoverage(mergedCoverage[filePath], fileCoverage)
    }
  }

  const summary = createSummary(mergedCoverage)

  await mkdir(totalCoverageDirectory, { recursive: true })
  await writeFile(
    join(totalCoverageDirectory, 'coverage-final.json'),
    JSON.stringify(mergedCoverage, null, 2),
    'utf8',
  )
  await writeFile(
    join(totalCoverageDirectory, 'summary.json'),
    JSON.stringify(summary, null, 2),
    'utf8',
  )

  console.log('\nOverall coverage summary')
  console.log(`Statements : ${summary.statements.pct.toFixed(2)}% (${summary.statements.covered}/${summary.statements.total})`)
  console.log(`Branches   : ${summary.branches.pct.toFixed(2)}% (${summary.branches.covered}/${summary.branches.total})`)
  console.log(`Functions  : ${summary.functions.pct.toFixed(2)}% (${summary.functions.covered}/${summary.functions.total})`)
  console.log(`Lines      : ${summary.lines.pct.toFixed(2)}% (${summary.lines.covered}/${summary.lines.total})`)
}

export async function runCoverage() {
  const coverageJobs = await loadCoverageJobs()

  await cleanupCoverageRoot()

  const failed = []

  for (const job of coverageJobs) {
    try {
      await runCoverageScript(job.scriptName)
    } catch (error) {
      failed.push({
        scriptName: job.scriptName,
        reason: error,
      })
    }
  }

  if (failed.length > 0) {
    for (const entry of failed) {
      console.error(
        entry.reason instanceof Error
          ? entry.reason.message
          : `Coverage script "${entry.scriptName}" failed.`,
      )
    }

    process.exitCode = 1
    return
  }

  await mergeCoverageReports(coverageJobs)
}

const entrypoint = process.argv[1]
if (typeof entrypoint === 'string' && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  await runCoverage()
}
