import { access, readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryUrl = 'git+https://github.com/cobraprojects/holo-js.git'
const releaseWorkflowPath = '.github/workflows/release.yml'
const requiredRootFiles = ['LICENSE', 'SECURITY.md']

async function exists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function normalizeRepositoryUrl(url) {
  return typeof url === 'string'
    ? url.replace(/^git\+/, '').replace(/\.git$/, '')
    : undefined
}

async function listPackageDirectories(root) {
  const entries = await readdir(join(root, 'packages'), { withFileTypes: true })

  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
}

async function collectPackageFailures(root, directory) {
  const packageRoot = join(root, 'packages', directory)
  const manifestPath = join(packageRoot, 'package.json')
  if (!(await exists(manifestPath))) return []

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.private === true) return []

  const label = `packages/${directory}`
  const failures = []
  if (!(await exists(join(packageRoot, 'LICENSE')))) {
    failures.push(`${label}/LICENSE is missing; every published package ships the license.`)
  }
  if (!Array.isArray(manifest.files) || !manifest.files.includes('LICENSE')) {
    failures.push(`${label}/package.json files must include "LICENSE".`)
  }
  if (normalizeRepositoryUrl(manifest.repository?.url) !== 'https://github.com/cobraprojects/holo-js') {
    failures.push(`${label}/package.json repository.url must be "${repositoryUrl}".`)
  }
  if (manifest.repository?.directory !== label) {
    failures.push(`${label}/package.json repository.directory must be "${label}".`)
  }

  return failures
}

async function collectReleaseWorkflowFailures(root) {
  const workflowPath = join(root, releaseWorkflowPath)
  if (!(await exists(workflowPath))) {
    return [`${releaseWorkflowPath} is missing; releases must publish from CI.`]
  }

  const workflow = await readFile(workflowPath, 'utf8')
  const failures = []
  if (!/^\s*id-token:\s*write\s*$/m.test(workflow)) {
    failures.push(`${releaseWorkflowPath} must grant id-token: write so npm can attest provenance.`)
  }
  if (!/NPM_CONFIG_PROVENANCE:\s*['"]?true['"]?/.test(workflow)) {
    failures.push(`${releaseWorkflowPath} must set NPM_CONFIG_PROVENANCE to 'true' so npm publishes with provenance.`)
  }
  if (!/git config user\.name\b/.test(workflow) || !/git config user\.email\b/.test(workflow)) {
    failures.push(`${releaseWorkflowPath} must set git user.name and user.email before publishing, because changeset publish creates annotated tags.`)
  }
  if (!/^ {4}if: github\.ref == 'refs\/heads\/main'$/m.test(workflow)) {
    failures.push(`${releaseWorkflowPath} must run the publish job only for refs/heads/main.`)
  }
  if (!/GITHUB_REF" = refs\/heads\/main \|\| .*exit 1/.test(workflow)) {
    failures.push(`${releaseWorkflowPath} must reject runs from refs other than main in an early step.`)
  }
  if (!/^ {10}ref: \$\{\{ github\.sha \}\}$/m.test(workflow)) {
    failures.push(`${releaseWorkflowPath} must check out github.sha, not a user-chosen ref.`)
  }
  if (!/^ {4}environment: release$/m.test(workflow)) {
    failures.push(`${releaseWorkflowPath} must declare environment: release so NPM_TOKEN sits behind its protection rules.`)
  }
  const unpinned = [...workflow.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)]
    .map(match => match[1])
    .filter(reference => !/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(reference))
  if (unpinned.length > 0) {
    failures.push(`${releaseWorkflowPath} must pin every action to a full 40-character commit SHA; unpinned: ${unpinned.join(', ')}.`)
  }
  const steps = workflow.split(/\n {6}- /)
  const tokenSteps = steps.filter(step => step.includes('secrets.NPM_TOKEN'))
  if (tokenSteps.length !== 1 || !/\bbun run release\b/.test(tokenSteps[0])) {
    failures.push(`${releaseWorkflowPath} must give NPM_TOKEN only to the publish step.`)
  }
  const buildIndex = steps.findIndex(step => /^\s*run: node scripts\/build-libraries\.mjs\s*$/m.test(step))
  const publishIndex = steps.findIndex(step => step.includes('release:skip-build'))
  const buildIsConditional = buildIndex !== -1 && /^(?:if|continue-on-error)\s*:|\n {8}(?:if|continue-on-error)\s*:/.test(steps[buildIndex])
  const buildFollowsPublish = publishIndex !== -1 && buildIndex > publishIndex
  if (buildIndex === -1 || buildIsConditional || buildFollowsPublish) {
    failures.push(`${releaseWorkflowPath} must build packages with \`node scripts/build-libraries.mjs\` in an unconditional step without continue-on-error, before the publish step, so declarations resolve in dependency order.`)
  }
  const jobHeaders = (workflow.split(/^jobs:\s*$/m)[1] ?? '').match(/^ {2}(?:[\w-]+|"[^"\n]+"|'[^'\n]+')\s*:(?:\s+#.*)?\s*$/gm) ?? []
  if (jobHeaders.length !== 1) {
    failures.push(`${releaseWorkflowPath} must build and publish in one job, because the built packages must reach the publish step on the same filesystem.`)
  }
  if (!/::notice\b/.test(workflow) || !/-z "\$NODE_AUTH_TOKEN"/.test(workflow)) {
    failures.push(`${releaseWorkflowPath} must skip the publish with a notice, not fail, when NPM_TOKEN is not configured.`)
  }
  if (!/git push origin --tags/.test(workflow)) {
    failures.push(`${releaseWorkflowPath} must push the tags that changeset publish creates with \`git push origin --tags\`.`)
  }
  if (!/\bbun run release\b/.test(workflow)) {
    failures.push(`${releaseWorkflowPath} must publish with \`bun run release\`, which restores package manifests.`)
  }

  return failures
}

export async function collectReleaseMetadataFailures(root = repoRoot) {
  const failures = []
  for (const file of requiredRootFiles) {
    if (!(await exists(join(root, file)))) {
      failures.push(`${file} is missing at the repository root.`)
    }
  }

  for (const directory of await listPackageDirectories(root)) {
    failures.push(...await collectPackageFailures(root, directory))
  }

  failures.push(...await collectReleaseWorkflowFailures(root))

  return failures
}

async function runReleaseMetadataValidation(root = repoRoot) {
  const failures = await collectReleaseMetadataFailures(root)

  if (failures.length > 0) {
    console.error('Release metadata validation failed:')
    for (const failure of failures) {
      console.error(`- ${failure}`)
    }
    return 1
  }

  console.log('Release metadata validated.')
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await runReleaseMetadataValidation())
}
