import { spawnSync } from 'node:child_process'

export const liveRegistryVariable = 'HOLO_SCAFFOLD_SMOKE_LIVE_REGISTRY'
const offlineVariable = 'HOLO_SCAFFOLD_SMOKE_OFFLINE'
const snapshotDistTag = 'holo-scaffold-smoke-snapshot'

function git(rootDir, args) {
  const result = spawnSync('git', args, { cwd: rootDir, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  }
  return result.stdout.trim()
}

export function resolveRegistrySnapshot(rootDir, now = new Date()) {
  if (git(rootDir, ['rev-parse', '--is-shallow-repository']) === 'true') {
    throw new Error('The scaffold smoke pins its npm registry snapshot to the last bun.lock commit, which a shallow clone cannot see. Fetch the full history first.')
  }

  if (git(rootDir, ['status', '--porcelain', '--', 'bun.lock']) !== '') {
    return now.toISOString()
  }

  const committedAt = git(rootDir, ['log', '-1', '--format=%cI', '--', 'bun.lock'])
  if (committedAt === '') {
    throw new Error('bun.lock has no commit history, so the scaffold smoke cannot pin its npm registry snapshot.')
  }

  return new Date(committedAt).toISOString()
}

export function scaffoldSmokeNpmEnvironment(rootDir, env = process.env) {
  const quietNpmSettings = {
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  }
  if (env[liveRegistryVariable] === '1') {
    return quietNpmSettings
  }

  return {
    ...quietNpmSettings,
    npm_config_before: resolveRegistrySnapshot(rootDir),
    npm_config_tag: snapshotDistTag,
    ...(env[offlineVariable] === '1' ? { npm_config_offline: 'true' } : {}),
  }
}
