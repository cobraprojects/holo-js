import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const contributingPage = 'apps/docs/docs/advanced/contributing.md'
const setupHeading = '## Set up the repository'

export function documentedSetupCommands(markdown) {
  const start = markdown.indexOf(`${setupHeading}\n`)
  if (start === -1) throw new Error(`${contributingPage} has no "${setupHeading}" section.`)
  const block = /```bash\n([\s\S]*?)```/.exec(markdown.slice(start))
  if (!block) throw new Error(`The "${setupHeading}" section has no bash block.`)
  const commands = block[1].split('\n').map(line => line.trim()).filter(Boolean)
  if (!commands[0]?.startsWith('git clone ') || !commands[1]?.startsWith('cd ')) {
    throw new Error(`The "${setupHeading}" bash block must start with git clone and cd.`)
  }
  return commands.slice(2)
}

export function setupFailures(checkoutDir) {
  const failures = []
  const appsDir = join(checkoutDir, 'apps')
  for (const app of readdirSync(appsDir).sort()) {
    const manifestPath = join(appsDir, app, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (!manifest.dependencies?.['@holo-js/cli'] && !manifest.devDependencies?.['@holo-js/cli']) continue
    const envPath = join(appsDir, app, '.env')
    const env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
    if (!/^APP_KEY=\S/m.test(env)) failures.push(`apps/${app}/.env has no APP_KEY.`)
    if (!/^BROADCAST_APP_KEY=\S/m.test(env)) failures.push(`apps/${app}/.env has no BROADCAST_APP_KEY.`)
  }
  return failures
}

function run(command, cwd) {
  console.log(`$ ${command}`)
  const result = spawnSync(command, { cwd, shell: true, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`"${command}" exited with ${result.status ?? result.signal}.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const repoRoot = resolve(import.meta.dirname, '..')
  const commands = documentedSetupCommands(readFileSync(join(repoRoot, contributingPage), 'utf8'))
  const workDir = mkdtempSync(join(tmpdir(), 'holo-contributor-setup-'))
  const checkoutDir = join(workDir, 'holo-js')
  try {
    run(`git clone --quiet --no-local "${repoRoot}" "${checkoutDir}"`, workDir)
    for (const command of commands) run(command, checkoutDir)
    const failures = setupFailures(checkoutDir)
    if (failures.length > 0) throw new Error(failures.join('\n'))
    console.log('The documented contributor setup works in a fresh clone.')
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  } finally {
    if (process.env.HOLO_KEEP_CONTRIBUTOR_SETUP !== '1') rmSync(workDir, { recursive: true, force: true })
  }
}
