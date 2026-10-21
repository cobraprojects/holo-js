import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, test } from 'node:test'
import {
  parseLinuxProcessStat,
  probeProcessGroup,
  validateNpmPublishAuthentication,
  withResolvedCatalogManifests,
} from './publish-with-resolved-catalogs.mjs'

const tempRoots = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(repoRoot => rm(repoRoot, {
    recursive: true,
    force: true,
  })))
})

async function createTempRepo(files) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'holo-publish-catalogs-'))
  tempRoots.push(repoRoot)

  for (const [filePath, contents] of Object.entries(files)) {
    const targetPath = join(repoRoot, filePath)
    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(targetPath, contents.join('\n'), 'utf8')
  }

  return repoRoot
}

test('catalog resolver restores package manifests after publishing fails', async () => {
  const originalManifest = [
    '{',
    '  "name": "@holo-js/example",',
    '  "version": "0.1.4",',
    '  "dependencies": {',
    '    "@holo-js/core": "catalog:"',
    '  }',
    '}',
    '',
  ].join('\n')

  const repoRoot = await createTempRepo({
    'package.json': [
      '{',
      '  "workspaces": {',
      '    "catalog": {',
      '      "@holo-js/core": "^0.1.4"',
      '    }',
      '  }',
      '}',
      '',
    ],
    'packages/example/package.json': originalManifest.split('\n'),
  })

  await assert.rejects(
    withResolvedCatalogManifests(async () => {
      const resolvedManifest = JSON.parse(await readFile(join(repoRoot, 'packages/example/package.json'), 'utf8'))
      assert.equal(resolvedManifest.dependencies['@holo-js/core'], '^0.1.4')
      throw new Error('publish failed')
    }, repoRoot),
    /publish failed/,
  )

  assert.equal(await readFile(join(repoRoot, 'packages/example/package.json'), 'utf8'), originalManifest)
})

test('catalog manifest publishing skips package directories without package manifests', async () => {
  const originalManifest = [
    '{',
    '  "name": "@holo-js/example",',
    '  "version": "0.1.4",',
    '  "dependencies": {',
    '    "@holo-js/core": "catalog:"',
    '  }',
    '}',
    '',
  ].join('\n')

  const repoRoot = await createTempRepo({
    'package.json': [
      '{',
      '  "workspaces": {',
      '    "catalog": {',
      '      "@holo-js/core": "^0.1.4"',
      '    }',
      '  }',
      '}',
      '',
    ],
    'packages/example/package.json': originalManifest.split('\n'),
    'packages/not-a-package/.keep': [''],
  })

  await withResolvedCatalogManifests(async () => {
    const resolvedManifest = JSON.parse(await readFile(join(repoRoot, 'packages/example/package.json'), 'utf8'))
    assert.equal(resolvedManifest.dependencies['@holo-js/core'], '^0.1.4')
  }, repoRoot)

  assert.equal(await readFile(join(repoRoot, 'packages/example/package.json'), 'utf8'), originalManifest)
})

test('npm publish authentication preflight returns the authenticated user', () => {
  const calls = []
  const user = validateNpmPublishAuthentication({
    root: '/repo',
    spawn: (command, args, options) => {
      calls.push({ command, args, options })

      return {
        status: 0,
        stdout: 'cobra\n',
        stderr: '',
      }
    },
  })

  assert.equal(user, 'cobra')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, ['whoami'])
  assert.equal(calls[0].options.cwd, '/repo')
  assert.equal(calls[0].options.encoding, 'utf8')
})

test('npm publish authentication preflight rejects invalid npm credentials', () => {
  assert.throws(
    () => validateNpmPublishAuthentication({
      root: '/repo',
      spawn: () => ({
        status: 1,
        stdout: '',
        stderr: 'npm error code E401\nnpm error 401 Unauthorized',
      }),
    }),
    /Cannot publish Holo packages because npm authentication failed\.[\s\S]*npm login[\s\S]*E401/,
  )
})


test('publishing resolves workspace ranges and restores original manifests', async () => {
  const original = '{"name":"@holo-js/example","devDependencies":{"@holo-js/core":"workspace:*"}}\n'
  const repoRoot = await createTempRepo({
    'package.json': ['{"workspaces":{"catalog":{"@holo-js/core":"^0.3.16"}}}'],
    'packages/core/package.json': ['{"name":"@holo-js/core","version":"0.3.16"}'],
    'packages/example/package.json': original.split('\n'),
  })
  await withResolvedCatalogManifests(async () => {
    const manifest = JSON.parse(await readFile(join(repoRoot, 'packages/example/package.json'), 'utf8'))
    assert.equal(manifest.devDependencies['@holo-js/core'], '^0.3.16')
  }, repoRoot)
  assert.equal(await readFile(join(repoRoot, 'packages/example/package.json'), 'utf8'), original)
})


test('published manifests expose only built files, never workspace source entries', async () => {
  const original = `${JSON.stringify({
    name: '@holo-js/example',
    exports: {
      '.': { '@holo-js/source': './src/index.ts', types: './dist/index.d.ts', import: './dist/index.mjs' },
      './runtime': { '@holo-js/source': './src/runtime.ts', import: './dist/runtime.mjs' },
      './context': {
        types: './dist/context.d.ts',
        node: { '@holo-js/source': './src/context.node.ts', default: './dist/context.node.mjs' },
        default: { '@holo-js/source': './src/context.ts', default: './dist/context.mjs' },
      },
      './styles.css': './dist/styles.css',
    },
  })}\n`
  const repoRoot = await createTempRepo({
    'package.json': ['{"workspaces":{"catalog":{}}}'],
    'packages/example/package.json': original.split('\n'),
  })
  await withResolvedCatalogManifests(async () => {
    const manifest = JSON.parse(await readFile(join(repoRoot, 'packages/example/package.json'), 'utf8'))
    assert.deepEqual(manifest.exports, {
      '.': { types: './dist/index.d.ts', import: './dist/index.mjs' },
      './runtime': { import: './dist/runtime.mjs' },
      './context': { types: './dist/context.d.ts', node: './dist/context.node.mjs', default: './dist/context.mjs' },
      './styles.css': './dist/styles.css',
    })
  }, repoRoot)
  assert.equal(await readFile(join(repoRoot, 'packages/example/package.json'), 'utf8'), original)
})

test('publishing restores every source manifest when preparation fails partway', async () => {
  const core = '{ "name": "@holo-js/core", "version": "0.3.16", "dependencies": { "external": "catalog:" } }\n'
  const consumer = '{ "name": "@holo-js/consumer", "dependencies": { "missing": "catalog:" } }\n'
  const root = await createTempRepo({
    'package.json': ['{"workspaces":{"catalog":{"external":"^1.0.0"}}}'],
    'packages/a-core/package.json': core.split('\n'),
    'packages/z-consumer/package.json': consumer.split('\n'),
  })
  await assert.rejects(withResolvedCatalogManifests(() => {
    assert.fail('Publishing must not begin with unresolved dependencies')
  }, root), /Cannot resolve catalog range/)
  assert.equal(await readFile(join(root, 'packages/a-core/package.json'), 'utf8'), core)
  assert.equal(await readFile(join(root, 'packages/z-consumer/package.json'), 'utf8'), consumer)
})

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  test(`catalog resolver restores package manifests when publishing receives ${signal}`, async () => {
    const originalManifest = '{ "name": "@holo-js/example", "dependencies": { "@holo-js/core": "catalog:" } }\n'
    const repoRoot = await createTempRepo({
      'package.json': ['{"workspaces":{"catalog":{"@holo-js/core":"^0.3.28"}}}'],
      'packages/example/package.json': originalManifest.split('\n'),
    })
    const modulePath = fileURLToPath(new URL('./publish-with-resolved-catalogs.mjs', import.meta.url))
    const child = spawn(process.execPath, ['--input-type=module', '--eval', [
      `import { withResolvedCatalogManifests } from ${JSON.stringify(modulePath)}`,
      `await withResolvedCatalogManifests(async () => {`,
      `  process.stdout.write('published\\n')`,
      `  await new Promise(() => setInterval(() => {}, 1000))`,
      `}, ${JSON.stringify(repoRoot)})`,
    ].join('\n')], { stdio: ['ignore', 'pipe', 'pipe'] })

    await new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('published')) resolve()
      })
      child.once('exit', code => reject(new Error(`publish child exited early with code ${code}`)))
    })
    assert.match(await readFile(join(repoRoot, 'packages/example/package.json'), 'utf8'), /"@holo-js\/core": "\^0\.3\.28"/)

    child.kill(signal)
    await once(child, 'exit')

    assert.equal(await readFile(join(repoRoot, 'packages/example/package.json'), 'utf8'), originalManifest)
  })
}

test('catalog resolver restores package manifests only after the interrupt hook finishes', async () => {
  const originalManifest = '{ "name": "@holo-js/example", "dependencies": { "@holo-js/core": "catalog:" } }\n'
  const repoRoot = await createTempRepo({
    'package.json': ['{"workspaces":{"catalog":{"@holo-js/core":"^0.3.28"}}}'],
    'packages/example/package.json': originalManifest.split('\n'),
  })
  const manifestPath = join(repoRoot, 'packages/example/package.json')
  const modulePath = fileURLToPath(new URL('./publish-with-resolved-catalogs.mjs', import.meta.url))
  const child = spawn(process.execPath, ['--input-type=module', '--eval', [
    `import { readFileSync } from 'node:fs'`,
    `import { withResolvedCatalogManifests } from ${JSON.stringify(modulePath)}`,
    `await withResolvedCatalogManifests(async () => {`,
    `  process.stdout.write('published\\n')`,
    `  await new Promise(() => setInterval(() => {}, 1000))`,
    `}, ${JSON.stringify(repoRoot)}, {`,
    `  onInterrupt: async () => {`,
    `    process.stdout.write('hook:' + readFileSync(${JSON.stringify(manifestPath)}, 'utf8').includes('^0.3.28') + '\\n')`,
    `    await new Promise(resolve => setTimeout(resolve, 200))`,
    `  },`,
    `})`,
  ].join('\n')], { stdio: ['ignore', 'pipe', 'pipe'] })

  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  await new Promise((resolve, reject) => {
    child.stdout.on('data', () => {
      if (output.includes('published')) resolve()
    })
    child.once('exit', code => reject(new Error(`publish child exited early with code ${code}`)))
  })

  child.kill('SIGTERM')
  await once(child, 'exit')

  assert.match(output, /hook:true/)
  assert.equal(await readFile(manifestPath, 'utf8'), originalManifest)
})

test('catalog resolver restores the remaining package manifests when one cannot be restored during an interrupt', async () => {
  const lockedManifest = '{ "name": "@holo-js/a-locked", "dependencies": { "@holo-js/core": "catalog:" } }\n'
  const writableManifest = '{ "name": "@holo-js/z-writable", "dependencies": { "@holo-js/core": "catalog:" } }\n'
  const repoRoot = await createTempRepo({
    'package.json': ['{"workspaces":{"catalog":{"@holo-js/core":"^0.3.28"}}}'],
    'packages/a-locked/package.json': lockedManifest.split('\n'),
    'packages/z-writable/package.json': writableManifest.split('\n'),
  })
  const lockedPath = join(repoRoot, 'packages/a-locked/package.json')
  const writablePath = join(repoRoot, 'packages/z-writable/package.json')
  const modulePath = fileURLToPath(new URL('./publish-with-resolved-catalogs.mjs', import.meta.url))
  const child = spawn(process.execPath, ['--input-type=module', '--eval', [
    `import { chmod } from 'node:fs/promises'`,
    `import { withResolvedCatalogManifests } from ${JSON.stringify(modulePath)}`,
    `await withResolvedCatalogManifests(async () => {`,
    `  await chmod(${JSON.stringify(lockedPath)}, 0o444)`,
    `  process.stdout.write('published\\n')`,
    `  await new Promise(() => setInterval(() => {}, 1000))`,
    `}, ${JSON.stringify(repoRoot)})`,
  ].join('\n')], { stdio: ['ignore', 'pipe', 'pipe'] })

  await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('published')) resolve()
    })
    child.once('exit', code => reject(new Error(`publish child exited early with code ${code}`)))
  })

  child.kill('SIGTERM')
  const [, signal] = await once(child, 'exit')

  assert.equal(signal, 'SIGTERM')
  assert.equal(await readFile(writablePath, 'utf8'), writableManifest)
  await chmod(lockedPath, 0o644)
})

test('catalog resolver keeps waiting for the interrupt hook when a second signal arrives', async () => {
  const originalManifest = '{ "name": "@holo-js/example", "dependencies": { "@holo-js/core": "catalog:" } }\n'
  const repoRoot = await createTempRepo({
    'package.json': ['{"workspaces":{"catalog":{"@holo-js/core":"^0.3.28"}}}'],
    'packages/example/package.json': originalManifest.split('\n'),
  })
  const manifestPath = join(repoRoot, 'packages/example/package.json')
  const modulePath = fileURLToPath(new URL('./publish-with-resolved-catalogs.mjs', import.meta.url))
  const child = spawn(process.execPath, ['--input-type=module', '--eval', [
    `import { withResolvedCatalogManifests } from ${JSON.stringify(modulePath)}`,
    `await withResolvedCatalogManifests(async () => {`,
    `  process.stdout.write('published\\n')`,
    `  await new Promise(() => setInterval(() => {}, 1000))`,
    `}, ${JSON.stringify(repoRoot)}, {`,
    `  onInterrupt: async () => {`,
    `    await new Promise(resolve => setTimeout(resolve, 300))`,
    `    process.stdout.write('hook-finished\\n')`,
    `  },`,
    `})`,
  ].join('\n')], { stdio: ['ignore', 'pipe', 'pipe'] })

  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  await new Promise((resolve, reject) => {
    child.stdout.on('data', () => {
      if (output.includes('published')) resolve()
    })
    child.once('exit', code => reject(new Error(`publish child exited early with code ${code}`)))
  })

  child.kill('SIGTERM')
  await new Promise(resolve => setTimeout(resolve, 50))
  child.kill('SIGTERM')
  await once(child, 'exit')

  assert.match(output, /hook-finished/)
  assert.equal(await readFile(manifestPath, 'utf8'), originalManifest)
})

const fakePublisherSource = [
  "import { spawn } from 'node:child_process'",
  "const [grandchildPath, ...grandchildArgs] = process.argv.slice(2)",
  "spawn(process.execPath, [grandchildPath, ...grandchildArgs], { stdio: 'inherit' })",
  'setInterval(() => {}, 1000)',
]

const fakeGrandchildSource = [
  "import { readFileSync, writeFileSync } from 'node:fs'",
  "const [manifestPath, markerPath, mode] = process.argv.slice(2)",
  'writeFileSync(`${markerPath}.pid`, String(process.pid))',
  'const finish = () => {',
  "  const resolved = readFileSync(manifestPath, 'utf8').includes('^0.3.28')",
  '  writeFileSync(markerPath, `resolved:${resolved}`)',
  '  process.exit(0)',
  '}',
  "if (mode === 'stubborn') {",
  "  process.on('SIGTERM', () => {})",
  '} else {',
  "  process.on('SIGTERM', () => setTimeout(finish, 300))",
  '}',
  "writeFileSync(`${markerPath}.ready`, '')",
  'setInterval(() => {}, 1000)',
]

async function runFakePublishInterrupt({ mode, graceMs }) {
  const originalManifest = '{ "name": "@holo-js/example", "dependencies": { "@holo-js/core": "catalog:" } }\n'
  const root = await createTempRepo({
    'package.json': ['{"workspaces":{"catalog":{"@holo-js/core":"^0.3.28"}}}'],
    'packages/example/package.json': originalManifest.split('\n'),
    'fake/publisher.mjs': fakePublisherSource,
    'fake/grandchild.mjs': fakeGrandchildSource,
  })
  const manifestPath = join(root, 'packages/example/package.json')
  const markerPath = join(root, 'fake/marker')
  const modulePath = fileURLToPath(new URL('./publish-with-resolved-catalogs.mjs', import.meta.url))
  const harness = [
    `import { existsSync } from 'node:fs'`,
    `import { startProcessTree, withResolvedCatalogManifests } from ${JSON.stringify(modulePath)}`,
    'let tree',
    'await withResolvedCatalogManifests(async () => {',
    `  tree = startProcessTree(process.execPath, [${JSON.stringify(join(root, 'fake/publisher.mjs'))}, ${JSON.stringify(join(root, 'fake/grandchild.mjs'))}, ${JSON.stringify(manifestPath)}, ${JSON.stringify(markerPath)}, ${JSON.stringify(mode)}], { cwd: ${JSON.stringify(root)}, graceMs: ${graceMs} })`,
    `  while (!existsSync(${JSON.stringify(`${markerPath}.ready`)})) await new Promise(resolve => setTimeout(resolve, 20))`,
    `  process.stdout.write('published\\n')`,
    '  await tree.exited',
    '  await new Promise(() => setInterval(() => {}, 1000))',
    `}, ${JSON.stringify(root)}, { onInterrupt: signal => tree.stop(signal) })`,
  ].join('\n')
  const child = spawn(process.execPath, ['--input-type=module', '--eval', harness], { stdio: ['ignore', 'pipe', 'pipe'] })

  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  await new Promise((resolve, reject) => {
    child.stdout.on('data', () => {
      if (output.includes('published')) resolve()
    })
    child.once('exit', code => reject(new Error(`publish child exited early with code ${code}`)))
  })

  child.kill('SIGTERM')
  const [, signal] = await once(child, 'exit')
  return { signal, manifestPath, markerPath, originalManifest }
}

test('catalog resolver restores manifests only after the publish grandchild exits on interrupt', async () => {
  const { signal, manifestPath, markerPath, originalManifest } = await runFakePublishInterrupt({ mode: 'cooperative', graceMs: 5000 })

  assert.equal(signal, 'SIGTERM')
  assert.equal(await readFile(`${markerPath}`, 'utf8'), 'resolved:true')
  assert.equal(await readFile(manifestPath, 'utf8'), originalManifest)
})

test('catalog resolver escalates to SIGKILL for a publish tree that ignores SIGTERM after the grace period', async () => {
  const { signal, manifestPath, markerPath, originalManifest } = await runFakePublishInterrupt({ mode: 'stubborn', graceMs: 200 })

  assert.equal(signal, 'SIGTERM')
  assert.equal(await readFile(manifestPath, 'utf8'), originalManifest)
  const grandchildPid = Number(await readFile(`${markerPath}.pid`, 'utf8'))
  assert.equal(processHasExited(grandchildPid), true)
})

test('Linux process stat parsing reads the state, group, and start time after a process name containing spaces and parentheses', () => {
  assert.deepEqual(
    parseLinuxProcessStat('4321 (node (publish) worker) Z 1 4000 4000 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 777 0 0'),
    { state: 'Z', pgrp: 4000, startTime: 777 },
  )
})

const zombie = (pgrp, startTime) => ({ pgrp, startTime, live: false })
const unrelatedLive = (startTime) => ({ pgrp: 5000, startTime, live: true })

function fakeProcessGroupReaders(passes) {
  let index = -1
  return {
    listPids() {
      index = Math.min(index + 1, passes.length - 1)
      return Object.keys(passes[index])
    },
    readGroupMember(pid, pgid) {
      const member = passes[index][pid]
      if (member === 'unreadable') throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      if (member === 'vanished') return null
      return member && member.pgrp === pgid ? { startTime: member.startTime, live: member.live } : null
    },
  }
}

test('a process group whose members are all zombies is treated as gone once two passes agree', () => {
  const pass = { 101: zombie(4000, 1), 102: zombie(4000, 2), 900: unrelatedLive(9) }

  assert.equal(probeProcessGroup(4000, fakeProcessGroupReaders([pass, pass])), 'gone')
})

test('a process group with a live member is still running when other members are zombies', () => {
  const pass = { 101: zombie(4000, 1), 102: { pgrp: 4000, startTime: 2, live: true } }

  assert.equal(probeProcessGroup(4000, fakeProcessGroupReaders([pass, pass])), 'live')
})

test('a descendant created during the scan keeps the group alive once it is seen running', () => {
  const before = { 101: zombie(4000, 1) }
  const during = { 101: zombie(4000, 1), 102: zombie(4000, 2) }
  const after = { 101: zombie(4000, 1), 102: { pgrp: 4000, startTime: 2, live: true } }

  assert.equal(probeProcessGroup(4000, fakeProcessGroupReaders([before, during, after])), 'live')
})

test('a reused process id with a new start time is verified again before the group is treated as gone', () => {
  const before = { 101: zombie(4000, 1) }
  const reused = { 101: zombie(4000, 2) }
  const reusedAndRunning = { 101: { pgrp: 4000, startTime: 2, live: true } }

  assert.equal(probeProcessGroup(4000, fakeProcessGroupReaders([before, reused, reusedAndRunning])), 'live')
})

test('unrelated processes appearing during every scan do not keep a zombie-only group alive', () => {
  const first = { 101: zombie(4000, 1), 900: unrelatedLive(9) }
  const second = { 101: zombie(4000, 1), 901: unrelatedLive(10) }

  assert.equal(probeProcessGroup(4000, fakeProcessGroupReaders([first, second])), 'gone')
})

test('a group member that exits during the scan does not keep the group alive', () => {
  const first = { 101: zombie(4000, 1), 102: zombie(4000, 2) }
  const second = { 101: zombie(4000, 1) }

  assert.equal(probeProcessGroup(4000, fakeProcessGroupReaders([first, second, second])), 'gone')
})

test('a group whose member identities never settle is reported as unsettled instead of gone', () => {
  const first = { 101: zombie(4000, 1) }
  const second = { 101: zombie(4000, 2) }
  const third = { 101: zombie(4000, 3) }

  assert.equal(probeProcessGroup(4000, fakeProcessGroupReaders([first, second, third])), 'unsettled')
})

test('a group member whose procfs read fails on every pass never settles as gone', () => {
  const pass = { 101: zombie(4000, 1), 102: 'unreadable' }

  assert.notEqual(probeProcessGroup(4000, fakeProcessGroupReaders([pass, pass, pass])), 'gone')
})

test('a pass with a failed procfs read does not count toward two agreeing passes', () => {
  const unreadable = { 101: zombie(4000, 1), 102: 'unreadable' }
  const complete = { 101: zombie(4000, 1) }

  assert.equal(probeProcessGroup(4000, fakeProcessGroupReaders([unreadable, complete, complete])), 'gone')
})

test('a group member that vanished and is absent from the next listing settles as gone', () => {
  const first = { 101: zombie(4000, 1), 102: 'vanished' }
  const second = { 101: zombie(4000, 1) }

  assert.equal(probeProcessGroup(4000, fakeProcessGroupReaders([first, second, second])), 'gone')
})

function processHasExited(pid) {
  try {
    process.kill(pid, 0)
  } catch (error) {
    return error.code === 'ESRCH'
  }
  if (process.platform !== 'linux') return false

  try {
    return parseLinuxProcessStat(readFileSync(`/proc/${pid}/stat`, 'utf8')).state === 'Z'
  } catch {
    return true
  }
}
