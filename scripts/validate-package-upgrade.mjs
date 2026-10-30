import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import semver from 'semver'

import { resolveReleaseManifest } from './release-manifests.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npmRegistryUrl = 'https://registry.npmjs.org'
const packageScope = '@holo-js'

const packageManagers = {
  npm: {
    install: ['npm', 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
    lockfile: 'package-lock.json',
    resolvesTo: (lockfile, name, version) => JSON.parse(lockfile).packages?.[`node_modules/${name}`]?.version === version,
  },
  bun: {
    install: ['bun', 'install', '--lockfile-only', '--ignore-scripts'],
    lockfile: 'bun.lock',
    resolvesTo: (lockfile, name, version) => lockfile.includes(`"${name}@${version}"`),
  },
}

async function readPublishableManifests(root) {
  const packagesDirectory = join(root, 'packages')
  const manifests = []
  const entries = await readdir(packagesDirectory, { withFileTypes: true })
  for (const entry of entries.filter(candidate => candidate.isDirectory())) {
    const manifestPath = join(packagesDirectory, entry.name, 'package.json')
    try {
      await access(manifestPath)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (manifest.private !== true && manifest.name.startsWith(`${packageScope}/`)) manifests.push(manifest)
  }

  return manifests
}

async function fetchPackument(upstream, name) {
  const response = await fetch(`${upstream}/${name.replace('/', '%2F')}`, { headers: { Accept: 'application/json' } })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`The registry responded ${response.status} for ${name}.`)

  return await response.json()
}

function resolveCandidateManifests(manifests, catalog, version) {
  const candidateCatalog = { ...catalog }
  for (const { name } of manifests) candidateCatalog[name] = `^${version}`

  return manifests.map(manifest => ({ ...resolveReleaseManifest(manifest, candidateCatalog), version }))
}

function collectRequiredExternalPeers(manifests) {
  const internalNames = new Set(manifests.map(({ name }) => name))
  const peers = {}
  for (const manifest of manifests) {
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (!internalNames.has(name) && manifest.peerDependenciesMeta?.[name]?.optional !== true) peers[name] = range
    }
  }

  return peers
}

async function packManifest(manifest, directory) {
  const packageDirectory = join(directory, manifest.name.replace('/', '__'))
  await mkdir(join(packageDirectory, 'package'), { recursive: true })
  await writeFile(join(packageDirectory, 'package', 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const tarballPath = join(packageDirectory, 'package.tgz')
  const result = spawnSync('tar', ['-czf', tarballPath, 'package'], { cwd: packageDirectory, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`Could not pack ${manifest.name}: ${result.stderr}`)

  return await readFile(tarballPath)
}

function describeCandidate(manifest, tarball, registryUrl) {
  const tarballName = `${manifest.name.split('/')[1]}-${manifest.version}.tgz`

  return {
    ...manifest,
    dist: {
      tarball: `${registryUrl}/${manifest.name}/-/${tarballName}`,
      shasum: createHash('sha1').update(tarball).digest('hex'),
      integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
    },
  }
}

async function startCandidateRegistry(upstream, candidates) {
  const releasePath = `/${randomUUID()}`
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://registry.local').pathname
      if (!pathname.startsWith(`${releasePath}/`)) {
        response.writeHead(404).end()
        return
      }
      const [name, tarballName] = decodeURIComponent(pathname.slice(releasePath.length + 1)).split('/-/')
      const candidate = candidates.get(name)
      if (tarballName !== undefined) {
        if (!candidate) {
          response.writeHead(404).end()
          return
        }
        response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(candidate.tarball)
        return
      }

      const packument = await fetchPackument(upstream, name) ?? { name, 'dist-tags': {}, versions: {} }
      if (candidate) {
        packument.versions[candidate.manifest.version] = describeCandidate(candidate.manifest, candidate.tarball, url)
        packument['dist-tags'] = { ...packument['dist-tags'], latest: candidate.manifest.version }
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(packument))
    } catch (error) {
      response.writeHead(502, { 'content-type': 'text/plain' }).end(String(error))
    }
  })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const url = `http://127.0.0.1:${server.address().port}${releasePath}`

  return {
    url,
    close: () => new Promise(resolveClose => server.close(resolveClose)),
  }
}

async function packCandidates(manifests, catalog, version, directory) {
  const candidates = new Map()
  for (const manifest of resolveCandidateManifests(manifests, catalog, version)) {
    candidates.set(manifest.name, { manifest, tarball: await packManifest(manifest, directory) })
  }

  return candidates
}

async function upgradeFixture({ packageManager, baselineDirectory, directory, dependencies, upstream, candidates }) {
  const registry = await startCandidateRegistry(upstream, candidates)
  try {
    await cp(baselineDirectory, directory, { recursive: true })
    await writeFixture(directory, dependencies, registry.url)
    const upgrade = await runPackageManager(packageManager, directory)
    if (!upgrade.ok) return upgrade.output

    const lockfile = await readFile(join(directory, packageManagers[packageManager].lockfile), 'utf8')
    const stale = Object.entries(dependencies)
      .filter(([name, version]) => candidates.has(name) && !packageManagers[packageManager].resolvesTo(lockfile, name, version))
      .map(([name]) => name)

    return stale.length > 0 ? `The lockfile still resolves ${stale.join(', ')} to an older version.` : undefined
  } finally {
    await registry.close()
  }
}

function runPackageManager(packageManager, cwd) {
  const [command, ...args] = packageManagers[packageManager].install
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  const output = []
  child.stdout.on('data', chunk => output.push(chunk))
  child.stderr.on('data', chunk => output.push(chunk))

  return new Promise((resolveRun, rejectRun) => {
    child.once('error', rejectRun)
    child.once('close', code => resolveRun({ ok: code === 0, output: Buffer.concat(output).toString('utf8').trim() }))
  })
}

async function writeFixture(directory, dependencies, registryUrl) {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), `${JSON.stringify({ name: 'holo-upgrade-fixture', private: true, dependencies }, null, 2)}\n`)
  await writeFile(join(directory, '.npmrc'), `${packageScope}:registry=${registryUrl}/\n`)
}

async function readBaseline(manifests, upstream) {
  const baseline = {}
  for (const { name } of manifests) {
    const latest = (await fetchPackument(upstream, name))?.['dist-tags']?.latest
    if (latest) baseline[name] = latest
  }
  if (Object.keys(baseline).length === 0) throw new Error(`No ${packageScope} package is published yet, so there is no release to upgrade from.`)

  return baseline
}

export async function validatePackageUpgrade({
  root = repoRoot,
  upstream = npmRegistryUrl,
  managers = Object.keys(packageManagers),
  log = () => {},
} = {}) {
  const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const catalog = rootManifest.workspaces?.catalog ?? {}
  const manifests = await readPublishableManifests(root)
  const baseline = await readBaseline(manifests, upstream)
  const latestRelease = semver.maxSatisfying(Object.values(baseline), '*')
  const workRoot = await mkdtemp(join(tmpdir(), 'holo-package-upgrade-'))
  const failures = []

  try {
    const externalPeers = collectRequiredExternalPeers(resolveCandidateManifests(manifests, catalog, latestRelease))
    const releases = []
    for (const release of ['patch', 'minor']) {
      const version = semver.inc(latestRelease, release)
      releases.push({ version, candidates: await packCandidates(manifests, catalog, version, join(workRoot, 'tarballs', version)) })
    }

    for (const packageManager of managers) {
      const baselineDirectory = join(workRoot, packageManager, latestRelease)
      await writeFixture(baselineDirectory, { ...externalPeers, ...baseline }, upstream)
      const baselineInstall = await runPackageManager(packageManager, baselineDirectory)
      if (!baselineInstall.ok) throw new Error(`${packageManager} could not install the published ${packageScope} packages:\n${baselineInstall.output}`)

      for (const { version, candidates } of releases) {
        const pinned = Object.fromEntries(Object.keys(baseline).map(name => [name, version]))
        const failure = await upgradeFixture({
          packageManager,
          baselineDirectory,
          directory: join(workRoot, packageManager, version),
          dependencies: { ...externalPeers, ...pinned },
          upstream,
          candidates,
        })
        if (failure === undefined) {
          log(`${packageManager}: upgrading every ${packageScope} package from ${latestRelease} to ${version} resolves`)
          continue
        }

        failures.push(`${packageManager} could not upgrade every ${packageScope} package from ${latestRelease} to ${version} with the previous lockfile:\n${failure}`)
      }
    }
  } finally {
    await rm(workRoot, { recursive: true, force: true })
  }

  return failures
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failures = await validatePackageUpgrade({ log: message => console.log(`[package-upgrade] ${message}`) })
  if (failures.length > 0) {
    for (const failure of failures) console.error(`::error title=Package upgrade check failed::${failure}`)
    process.exit(1)
  }
}
