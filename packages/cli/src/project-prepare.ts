import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import type {
  HoloProjectPrepareChange,
  HoloProjectPrepareCommand,
  HoloProjectPrepareRun,
} from '@holo-js/kernel'
import type { IoStreams } from './cli-types'
import { readProjectDependencyNames } from './package-json'
import { installProjectDependencies, resolveProjectPackageManager } from './package-manager'
import {
  ensureProjectConfig,
  ensureGeneratedSchemaPlaceholder,
  prepareProjectDiscovery,
  renderFrameworkRunnerForDescriptor,
  syncManagedDriverDependencies,
  readTextFile,
  writeTextFile,
} from './project'
import {
  getFrameworkDescriptorByIdFrom,
  getFrameworkDescriptorsWith,
  type FrameworkDescriptor,
} from './project/frameworks'
import { loadProjectPluginFrameworkDescriptors } from './project/plugins'
import { runPluginProjectPreparers } from './project/plugin-prepare/coordinator'

type ProjectPrepareOptions = {
  readonly prepareSchema?: boolean
  readonly syncFramework?: boolean
  readonly command?: HoloProjectPrepareCommand
  readonly reason?: Extract<HoloProjectPrepareRun, { kind: 'full' }>['reason']
  readonly changes?: readonly HoloProjectPrepareChange[]
  readonly signal?: AbortSignal
}

type FrameworkPreparation = {
  readonly framework?: FrameworkDescriptor
  readonly sync?: FrameworkDescriptor['sync']
}

async function discoverFrameworkPreparation(projectRoot: string): Promise<FrameworkPreparation> {
  const pluginDescriptors = await loadProjectPluginFrameworkDescriptors(projectRoot)
  const descriptors = getFrameworkDescriptorsWith(pluginDescriptors)
  const dependencyNames = await readProjectDependencyNames(projectRoot)
  let framework: FrameworkDescriptor | undefined
  try {
    const content = await readTextFile(resolve(projectRoot, '.holo-js/framework/project.json'))
    if (content) {
      const manifest = JSON.parse(content) as { framework?: unknown }
      if (typeof manifest.framework === 'string') {
        framework = getFrameworkDescriptorByIdFrom(manifest.framework, pluginDescriptors)
      }
    }
  } catch {
    framework = undefined
  }
  framework ??= descriptors.find(descriptor => descriptor.detectPackages.some(name => dependencyNames.has(name)))
  const sync = framework
    ? descriptors.find(descriptor => descriptor.id === framework.id && descriptor.sync)?.sync
    : undefined
  return { framework, sync }
}

async function prepareFrameworkPass(
  projectRoot: string,
  project: Awaited<ReturnType<typeof ensureProjectConfig>>,
  run: HoloProjectPrepareRun,
  io: IoStreams | undefined,
  options: ProjectPrepareOptions,
): Promise<void> {
  options.signal?.throwIfAborted()
  const { framework, sync } = await discoverFrameworkPreparation(projectRoot)
  options.signal?.throwIfAborted()
  await runPluginProjectPreparers(projectRoot, project.config, {
    run,
    ...(framework ? {
      framework: {
        id: framework.id,
        displayName: framework.displayName,
        adapterPackage: framework.adapterPackage,
        ...(framework.fluxPackage ? { fluxPackage: framework.fluxPackage } : {}),
        capabilities: framework.capabilities,
      },
    } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    writeInfo: message => io?.stdout.write(`${message}\n`),
    writeWarning: message => io?.stderr.write(`${message}\n`),
  })
  options.signal?.throwIfAborted()
  if (!framework) return
  await writeTextFile(resolve(projectRoot, '.holo-js/framework/project.json'), `${JSON.stringify({ framework: framework.id }, null, 2)}\n`)
  await writeTextFile(resolve(projectRoot, '.holo-js/framework/run.mjs'), renderFrameworkRunnerForDescriptor(framework))
  options.signal?.throwIfAborted()
  if (options.syncFramework === false || !sync) return
  await runFrameworkSync(projectRoot, sync, options.signal)
}

export async function runProjectPrepare(
  projectRoot: string,
  io?: IoStreams,
  options: ProjectPrepareOptions = {},
): Promise<void> {
  options.signal?.throwIfAborted()
  const project = options.prepareSchema === false
    ? await ensureProjectConfig(projectRoot)
    : await prepareProjectSchema(projectRoot)
  const command = options.command ?? 'prepare'
  const run: HoloProjectPrepareRun = options.changes && command === 'dev'
    ? { kind: 'incremental', command: 'dev', changes: options.changes }
    : { kind: 'full', command, reason: options.reason ?? (command === 'prepare' ? 'explicit' : 'initial') }
  await prepareFrameworkPass(projectRoot, project, run, io, options)
  options.signal?.throwIfAborted()
  const updatedDependencies = await syncManagedDriverDependencies(projectRoot)
  if (!updatedDependencies || !io) return
  options.signal?.throwIfAborted()
  await installProjectDependencies(io, projectRoot, spawn, options.signal)
  options.signal?.throwIfAborted()
  const refreshedProject = await ensureProjectConfig(projectRoot)
  await prepareProjectDiscovery(projectRoot, refreshedProject.config)
  await prepareFrameworkPass(projectRoot, refreshedProject, { kind: 'full', command, reason: 'dependencies-changed' }, io, options)
}

export async function prepareProjectSchema(projectRoot: string): Promise<Awaited<ReturnType<typeof ensureProjectConfig>>> {
  const project = await ensureProjectConfig(projectRoot)
  await ensureGeneratedSchemaPlaceholder(projectRoot, project.config)
  await prepareProjectDiscovery(projectRoot, project.config)
  return project
}

async function runFrameworkSync(
  projectRoot: string,
  sync: NonNullable<FrameworkDescriptor['sync']>,
  signal?: AbortSignal,
): Promise<void> {
  const manager = await resolveProjectPackageManager(projectRoot)
  signal?.throwIfAborted()
  const invocation = sync.commands[manager]
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(invocation[0], invocation.slice(1), {
      cwd: projectRoot,
      stdio: 'inherit',
      ...(signal ? { signal } : {}),
    })
    let processError: Error | undefined
    child.on('error', (error) => {
      processError = error
    })
    child.on('close', (code: number | null) => {
      if (processError) reject(processError)
      else if (code === 0) resolvePromise()
      else reject(new Error(`${sync.errorLabel} exited with ${code}`))
    })
  })
}
