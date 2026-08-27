import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { clearConfigCache, resolveConfigCachePath } from '@holo-js/config'
import {
  parseTokens,
  isInteractive,
  promptChoice,
  promptMultiChoice,
  normalizeChoice,
  normalizeOptionalPackages,
  resolveNewProjectInput,
  ensureRequiredArg,
  resolveStringFlag,
  collectMultiStringFlag,
  resolveBooleanFlag,
  parseNumberFlag,
  splitCsv,
  SUPPORTED_INSTALL_TARGETS,
  SUPPORTED_CACHE_INSTALL_DRIVERS,
  SUPPORTED_QUEUE_INSTALL_DRIVERS,
} from './parsing'
import { generateProjectAppKey } from './app-key'
import { ensureEmptyDirectory, fileExists } from './fs-utils'
import { runWithSpinner, writeLine } from './io'
import { hasProjectDependency, pinProjectDependencyVersions, removeProjectDependency, upsertProjectDependency } from './package-json'
import type * as ProjectPluginsModule from './project/plugins'
import type * as ProjectScaffoldModule from './project/scaffold'
import type * as AgentSkillsModule from './agent-skills'
import {
  APP_CONFIG_FILE_NAMES,
  SUPPORTED_AUTH_SOCIAL_PROVIDERS,
  type SupportedAuthSocialProvider,
} from './project/shared'
import type { LoadedProjectConfig, CommandFlagValue, CommandExecutionContext } from './types'
import { createAppCommandRuntimeBoundary } from './app-command-runtime'
import type {
  IoStreams,
  CommandDefinition,
  InternalCommandContext,
  PreparedInput,
  SupportedScaffoldFramework,
  SupportedScaffoldPackageManager,
  SupportedScaffoldStorageDisk,
  SupportedCacheInstallerDriver,
  SupportedQueueInstallerDriver,
  ProjectScaffoldOptions,
  DiscoveredAppCommand,
} from './cli-types'
import {
  loadAgentSkillsModule,
  loadProjectConfigModule,
  loadProjectDiscoveryModule,
  loadProjectPluginsModule,
  loadProjectRuntimeModule,
  loadProjectScaffoldModule,
  loadRuntimeModule,
  loadSecurityModule,
  resolveBroadcastExecutor,
  resolveCacheExecutor,
  resolveGeneratorCommand,
  resolveMediaExecutor,
  resolveProjectExecutor,
  resolveQueueExecutor,
  resolveRuntimeExecutor,
  type BroadcastCommandExecutors,
  type CacheCommandExecutors,
  type MediaCommandExecutors,
  type ProjectCommandExecutors,
  type QueueCommandExecutors,
  type RuntimeExecutor,
  type SecurityCommandExecutors,
} from './command-executors'

const AUTH_INSTALL_FEATURES = ['social', 'workos', 'clerk'] as const
const AUTH_SOCIAL_PROVIDER_MODES = ['default', 'specific'] as const
const EVENTS_QUEUE_ACTIONS = ['skip', 'enable'] as const
const MODEL_GENERATOR_OPTIONS = ['migration', 'observer', 'seeder', 'factory'] as const
const COMMAND_LIST_DESCRIPTION_COLUMN = 32

type AuthInstallFeature = typeof AUTH_INSTALL_FEATURES[number]
type AuthSocialProviderMode = typeof AUTH_SOCIAL_PROVIDER_MODES[number]
type EventsQueueAction = typeof EVENTS_QUEUE_ACTIONS[number]
type ModelGeneratorOption = typeof MODEL_GENERATOR_OPTIONS[number]

type FileSnapshot = {
  readonly path: string
  readonly contents: string
}
type DirectorySnapshot = {
  readonly path: string
  readonly snapshotPath?: string
}

export function createCommandContext(
  io: IoStreams,
  projectRoot: string,
  loadProject: () => Promise<LoadedProjectConfig>,
  input: PreparedInput,
): CommandExecutionContext {
  const withRuntime = createAppCommandRuntimeBoundary(projectRoot, loadProject)
  return {
    cwd: io.cwd,
    projectRoot,
    args: input.args,
    flags: input.flags,
    loadProject,
    withRuntime,
  }
}

function serializePassthroughInput(input: Pick<CommandExecutionContext, 'args' | 'flags'>): string[] {
  const tokens = [...input.args]

  for (const [name, value] of Object.entries(input.flags)) {
    if (value === false) {
      continue
    }

    const flag = name.length === 1 ? `-${name}` : `--${name}`
    const values = Array.isArray(value) ? value : [value]

    for (const currentValue of values) {
      tokens.push(flag)
      if (currentValue !== true) {
        tokens.push(String(currentValue))
      }
    }
  }

  return tokens
}

export function printCommandList(io: IoStreams, registry: readonly CommandDefinition[]): void {
  const internal = registry.filter(command => command.source === 'internal')
  const app = registry.filter(command => command.source === 'app')

  writeLine(io.stdout, 'Usage:')
  writeLine(io.stdout, '  holo <command> [options] [arguments]')
  writeLine(io.stdout)
  writeLine(io.stdout, 'Internal commands:')
  printCommandListEntries(io, internal)

  writeLine(io.stdout)
  writeLine(io.stdout, 'App commands:')
  if (app.length === 0) {
    writeLine(io.stdout, '  (none)')
    return
  }

  printCommandListEntries(io, app)
}

function printCommandListEntries(io: IoStreams, commands: readonly CommandDefinition[]): void {
  for (const command of commands) {
    printCommandListEntry(io, command)
  }
}

function printCommandListEntry(io: IoStreams, command: CommandDefinition): void {
  writeLine(io.stdout, `  ${command.name.padEnd(COMMAND_LIST_DESCRIPTION_COLUMN)}${command.description}`)
}

export function printCommandHelp(io: IoStreams, command: CommandDefinition): void {
  writeLine(io.stdout, command.usage)
  writeLine(io.stdout, command.description)
}

export function resolvePackageManagerInstallCommand(packageManager: SupportedScaffoldPackageManager): string {
  switch (packageManager) {
    case 'bun':
      return 'bun install'
    case 'npm':
      return 'npm install'
    case 'pnpm':
      return 'pnpm install'
    case 'yarn':
      return 'yarn install'
  }
}

export function resolvePackageManagerDevCommand(packageManager: SupportedScaffoldPackageManager): string {
  switch (packageManager) {
    case 'bun':
      return 'bun run dev'
    case 'npm':
      return 'npm run dev'
    case 'pnpm':
      return 'pnpm dev'
    case 'yarn':
      return 'yarn dev'
  }
}

async function runProjectDependencyInstallAfterPackageJsonUpdate(
  context: InternalCommandContext,
  projectExecutors: ProjectCommandExecutors,
  updatedPackageJson: boolean,
): Promise<void> {
  if (!updatedPackageJson) {
    return
  }

  await runProjectDependencyInstallForProject(context, projectExecutors, context.projectRoot)
  const runProjectPrepare = await resolveProjectExecutor(projectExecutors, 'runProjectPrepare')
  await runProjectPrepare(context.projectRoot, context)
}

async function runProjectDependencyInstallForProject(
  context: InternalCommandContext,
  projectExecutors: ProjectCommandExecutors,
  projectRoot: string,
  options: { readonly writeStatus?: boolean } = {},
): Promise<void> {
  const runProjectDependencyInstall = await resolveProjectExecutor(projectExecutors, 'runProjectDependencyInstall')
  await runProjectDependencyInstall(context, projectRoot)
  if (options.writeStatus ?? true) {
    writeLine(context.stdout, '  - installed dependencies')
  }
}

function formatPluginLabel(plugin: ProjectPluginsModule.HoloPluginDefinition): string {
  return plugin.name ? `${plugin.name} (${plugin.id})` : plugin.id
}

function formatPluginContributionLines(plugin: ProjectPluginsModule.HoloPluginDefinition): readonly string[] {
  const contributes = plugin.contributes
  if (!contributes) {
    return []
  }

  const lines: string[] = []

  if (contributes.framework) {
    lines.push(`framework: ${contributes.framework.displayName}`)
  }

  if (contributes.project?.prepare) {
    lines.push(`project preparer: ${contributes.project.prepare}`)
  }

  if (contributes.dependencies?.holo?.length) {
    lines.push(`holo packages: ${contributes.dependencies.holo.join(', ')}`)
  }

  if (contributes.dependencies?.runtime?.length) {
    lines.push(`runtime packages: ${contributes.dependencies.runtime.join(', ')}`)
  }

  if (contributes.config?.files?.length) {
    lines.push(`config files: ${contributes.config.files.join(', ')}`)
  }

  if (contributes.config?.env?.length) {
    lines.push(`env keys: ${contributes.config.env.join(', ')}`)
  }

  if (contributes.broadcast?.drivers) {
    const driverNames = Object.keys(contributes.broadcast.drivers)
    if (driverNames.length > 0) {
      lines.push(`broadcast drivers: ${driverNames.join(', ')}`)
    }
  }

  if (contributes.cache?.drivers) {
    const driverNames = Object.keys(contributes.cache.drivers)
    if (driverNames.length > 0) {
      lines.push(`cache drivers: ${driverNames.join(', ')}`)
    }
  }

  if (contributes.queue?.drivers) {
    const driverNames = Object.keys(contributes.queue.drivers)
    if (driverNames.length > 0) {
      lines.push(`queue drivers: ${driverNames.join(', ')}`)
    }
  }

  if (contributes.mail?.drivers) {
    const driverNames = Object.keys(contributes.mail.drivers)
    if (driverNames.length > 0) {
      lines.push(`mail drivers: ${driverNames.join(', ')}`)
    }
  }

  if (contributes.notifications?.channels) {
    const channelNames = Object.keys(contributes.notifications.channels)
    if (channelNames.length > 0) {
      lines.push(`notification channels: ${channelNames.join(', ')}`)
    }
  }

  if (contributes.runtime?.boot) {
    lines.push(`runtime boot: ${contributes.runtime.boot}`)
  }

  if (contributes.cli?.commands) {
    lines.push(`cli commands: ${contributes.cli.commands}`)
  }

  if (contributes.migrations?.publish) {
    lines.push(`migration publisher: ${contributes.migrations.publish}`)
  }

  return lines
}

function writePluginDetails(
  context: InternalCommandContext,
  loadedPlugin: ProjectPluginsModule.LoadedHoloPlugin,
): void {
  writeLine(context.stdout, `Plugin: ${formatPluginLabel(loadedPlugin.definition)}`)
  writeLine(context.stdout, `  - package: ${loadedPlugin.packageName}`)
  if (loadedPlugin.definition.description) {
    writeLine(context.stdout, `  - description: ${loadedPlugin.definition.description}`)
  }

  const contributionLines = formatPluginContributionLines(loadedPlugin.definition)
  if (contributionLines.length === 0) {
    writeLine(context.stdout, '  - contributions: none')
    return
  }

  for (const line of contributionLines) {
    writeLine(context.stdout, `  - ${line}`)
  }
}

async function readPackageJsonSnapshot(projectRoot: string): Promise<string> {
  return await readFile(resolve(projectRoot, 'package.json'), 'utf8')
}

async function restorePackageJsonSnapshot(projectRoot: string, snapshot: string): Promise<void> {
  await writeFile(resolve(projectRoot, 'package.json'), snapshot)
}

async function readAppConfigSnapshot(projectRoot: string): Promise<FileSnapshot | undefined> {
  for (const fileName of APP_CONFIG_FILE_NAMES) {
    const path = resolve(projectRoot, fileName)
    if (await fileExists(path)) {
      return {
        path,
        contents: await readFile(path, 'utf8'),
      }
    }
  }

  return undefined
}

async function restoreAppConfigSnapshot(snapshot: FileSnapshot | undefined): Promise<void> {
  if (!snapshot) {
    return
  }

  await writeFile(snapshot.path, snapshot.contents)
}

async function readDirectorySnapshot(projectRoot: string, relativePath: string): Promise<DirectorySnapshot> {
  const path = resolve(projectRoot, relativePath)
  if (!await fileExists(path)) {
    return { path }
  }

  const snapshotPath = await mkdtemp(resolve(tmpdir(), 'holo-cli-plugin-add-'))
  await cp(path, snapshotPath, { recursive: true, force: true })
  return { path, snapshotPath }
}

async function restoreDirectorySnapshot(snapshot: DirectorySnapshot): Promise<void> {
  await rm(snapshot.path, { recursive: true, force: true })
  if (snapshot.snapshotPath) {
    await cp(snapshot.snapshotPath, snapshot.path, { recursive: true, force: true })
  }
}

async function cleanupDirectorySnapshot(snapshot: DirectorySnapshot): Promise<void> {
  if (snapshot.snapshotPath) {
    await rm(snapshot.snapshotPath, { recursive: true, force: true })
  }
}

export function createInternalCommands(
  context: InternalCommandContext,
  runtimeExecutor?: RuntimeExecutor,
  queueExecutors: QueueCommandExecutors = {},
  projectExecutors: ProjectCommandExecutors = {},
  broadcastExecutors: BroadcastCommandExecutors = {},
  securityExecutors: SecurityCommandExecutors = {},
  cacheExecutors: CacheCommandExecutors = {},
  mediaExecutors: MediaCommandExecutors = {},
): CommandDefinition[] {
  return [
    {
      name: 'list',
      description: 'List all available internal and app commands.',
      usage: 'holo list',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        printCommandList(context, context.registry)
      },
    },
    {
      name: 'new',
      description: 'Scaffold a new Holo project',
      usage: 'holo new <name> [--framework <nuxt|next|sveltekit>] [--database <sqlite|mysql|postgres>] [--package-manager <bun|npm|pnpm|yarn>] [--package <storage|events|queue|validation|forms|auth|authorization|notifications|mail|broadcast|realtime|security|cache>] [--storage-default-disk <local|public>]',
      source: 'internal',
      async prepare(input) {
        const resolved = await resolveNewProjectInput(
          context,
          input,
          undefined,
          projectName => ensureEmptyDirectory(resolve(context.cwd, projectName), projectName),
        )

        return {
          args: [resolved.projectName],
          flags: {
            framework: resolved.framework,
            database: resolved.databaseDriver,
            ['package-manager']: resolved.packageManager,
            ['storage-default-disk']: resolved.storageDefaultDisk,
            ...(resolved.optionalPackages.length > 0
              ? { package: resolved.optionalPackages }
              : {}),
          },
        }
      },
      async run(commandContext) {
        const projectName = String(commandContext.args[0] ?? '')
        const framework = String(commandContext.flags.framework ?? 'nuxt') as SupportedScaffoldFramework
        const databaseDriver = String(commandContext.flags.database ?? 'sqlite') as ProjectScaffoldOptions['databaseDriver']
        const packageManager = String(commandContext.flags['package-manager'] ?? 'bun') as SupportedScaffoldPackageManager
        const storageDefaultDisk = String(commandContext.flags['storage-default-disk'] ?? 'local') as SupportedScaffoldStorageDisk
        const optionalPackages = normalizeOptionalPackages(
          (collectMultiStringFlag(commandContext.flags, 'package') ?? []).flatMap(entry => splitCsv(entry) ?? []),
        )
        const targetDir = resolve(commandContext.cwd, projectName)

        const { scaffoldProject } = await loadProjectScaffoldModule()
        await runWithSpinner(
          context,
          'Creating project files...',
          () => scaffoldProject(targetDir, {
            projectName,
            framework,
            databaseDriver,
            packageManager,
            storageDefaultDisk,
            optionalPackages,
          }),
          'Project files created.',
        )

        writeLine(context.stdout, `Created Holo project: ${targetDir}`)
        await runWithSpinner(
          context,
          `Installing dependencies with ${packageManager}...`,
          () => runProjectDependencyInstallForProject(context, projectExecutors, targetDir, {
            writeStatus: false,
          }),
          `Dependencies installed with ${packageManager}.`,
        )
        writeLine(context.stdout)
        writeLine(context.stdout, 'Next steps')
        writeLine(context.stdout, `  cd ${projectName}`)
        writeLine(context.stdout, `  ${resolvePackageManagerDevCommand(packageManager)}`)
      },
    },
    {
      name: 'agents:install',
      aliases: ['agent:install', 'ai:install'],
      description: 'Install Holo-JS docs-search skills for coding agents.',
      usage: 'holo agents:install [--agent <all|codex|claude|cursor|windsurf|opencode|gemini|kiro>] [--global] [--force]',
      source: 'internal',
      async prepare(input) {
        const { normalizeAgentSkillTargets, SUPPORTED_AGENT_SKILL_TARGETS } = await loadAgentSkillsModule()
        const requestedAgents = (collectMultiStringFlag(input.flags, 'agent') ?? []).flatMap(entry => splitCsv(entry) ?? [])
        const agents = requestedAgents.length > 0
          ? normalizeAgentSkillTargets(requestedAgents)
          : isInteractive(context, input.flags)
            ? await promptMultiChoice(context, 'Coding agents', SUPPORTED_AGENT_SKILL_TARGETS, {
                required: true,
                initialValues: [...SUPPORTED_AGENT_SKILL_TARGETS],
              })
            : normalizeAgentSkillTargets([])

        return {
          args: [],
          flags: {
            agent: agents,
            ...(resolveBooleanFlag(input.flags, 'global') === true ? { global: true } : {}),
            ...(resolveBooleanFlag(input.flags, 'force') === true ? { force: true } : {}),
          },
        }
      },
      async run(commandContext) {
        const { installAgentSkills } = await loadAgentSkillsModule()
        const agents = (collectMultiStringFlag(commandContext.flags, 'agent') ?? []) as AgentSkillsModule.SupportedAgentSkillTarget[]
        const results = await installAgentSkills(context.projectRoot, {
          agents,
          global: commandContext.flags.global === true,
          force: commandContext.flags.force === true,
        })
        const created = results.filter(result => result.status === 'created').length
        const updated = results.filter(result => result.status === 'updated').length
        const unchanged = results.filter(result => result.status === 'unchanged').length
        const changed = created + updated

        writeLine(
          context.stdout,
          changed > 0
            ? 'Installed Holo-JS agent skills.'
            : 'Holo-JS agent skills are already installed.',
        )

        for (const result of results) {
          writeLine(context.stdout, `  - ${result.status} ${result.agent}: ${result.path}`)
        }

        writeLine(context.stdout, `  - summary: ${created} created, ${updated} updated, ${unchanged} unchanged`)
      },
    },
    {
      name: 'key:generate',
      description: 'Generate APP_KEY in the project .env file when it is missing.',
      usage: 'holo key:generate',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        const result = await generateProjectAppKey(context.projectRoot)

        writeLine(
          context.stdout,
          result.generated
            ? `Generated APP_KEY in ${result.envPath}.`
            : `APP_KEY is already set in ${result.envPath}.`,
        )
      },
    },
    {
      name: 'install',
      description: 'Install first-party Holo support into an existing project.',
      usage: 'holo install <queue|events|auth|authorization|notifications|mail|broadcast|realtime|security|cache|media> [--driver <queue: sync|file|redis|database; cache: file|redis|database>] [--social] [--provider <google|github|discord|facebook|apple|linkedin>] [--workos] [--clerk]',
      source: 'internal',
      async prepare(input) {
        const interactive = isInteractive(context, input.flags)
        const requestedTarget = input.args[0]?.trim()
        const target = normalizeChoice(
          requestedTarget || (interactive
            ? await promptChoice(context, 'Install target', SUPPORTED_INSTALL_TARGETS, 'queue')
            : await ensureRequiredArg(context, input, 0, 'Install target')),
          SUPPORTED_INSTALL_TARGETS,
          'install target',
        )
        const requestedDriver = resolveStringFlag(input.flags, 'driver')
        if (target === 'events' && requestedDriver) {
          throw new Error('The events installer does not support --driver.')
        }
        if (target === 'auth' && requestedDriver) {
          throw new Error('The auth installer does not support --driver.')
        }
        if (target === 'authorization' && requestedDriver) {
          throw new Error('The authorization installer does not support --driver.')
        }
        if (target === 'notifications' && requestedDriver) {
          throw new Error('The notifications installer does not support --driver.')
        }
        if (target === 'mail' && requestedDriver) {
          throw new Error('The mail installer does not support --driver.')
        }
        if (target === 'broadcast' && requestedDriver) {
          throw new Error('The broadcast installer does not support --driver.')
        }
        if (target === 'realtime' && requestedDriver) {
          throw new Error('The realtime installer does not support --driver.')
        }
        if (target === 'security' && requestedDriver) {
          throw new Error('The security installer does not support --driver.')
        }
        if (target === 'media' && requestedDriver) {
          throw new Error('The media installer does not support --driver.')
        }

        const driver = target === 'queue'
          ? (requestedDriver
              ? normalizeChoice(requestedDriver, SUPPORTED_QUEUE_INSTALL_DRIVERS, 'queue driver')
              : interactive
                ? await promptChoice(context, 'Queue driver', SUPPORTED_QUEUE_INSTALL_DRIVERS, 'sync')
                : 'sync')
          : target === 'cache'
            ? (requestedDriver
                ? normalizeChoice(requestedDriver, SUPPORTED_CACHE_INSTALL_DRIVERS, 'cache driver')
                : interactive
                  ? await promptChoice(context, 'Cache driver', SUPPORTED_CACHE_INSTALL_DRIVERS, 'file')
                  : 'file')
            : undefined
        let socialProviders = target === 'auth'
          ? ((collectMultiStringFlag(input.flags, 'provider') ?? [])
              .flatMap(entry => splitCsv(entry) ?? [])
              .map(provider => normalizeChoice(provider, SUPPORTED_AUTH_SOCIAL_PROVIDERS, 'auth social provider')) as SupportedAuthSocialProvider[])
          : []
        let social = target === 'auth'
          ? resolveBooleanFlag(input.flags, 'social') === true || socialProviders.length > 0
          : false
        let workos = target === 'auth'
          ? resolveBooleanFlag(input.flags, 'workos') === true
          : false
        let clerk = target === 'auth'
          ? resolveBooleanFlag(input.flags, 'clerk') === true
          : false
        const authFlagsProvided = 'social' in input.flags
          || 'provider' in input.flags
          || 'workos' in input.flags
          || 'clerk' in input.flags

        if (target === 'auth' && interactive && !authFlagsProvided) {
          const features = await promptMultiChoice<AuthInstallFeature>(
            context,
            'Auth providers',
            AUTH_INSTALL_FEATURES,
            {
              labels: {
                social: 'Social OAuth',
                workos: 'WorkOS',
                clerk: 'Clerk',
              },
              hints: {
                social: 'Google, GitHub, Discord, Facebook, Apple, or LinkedIn',
              },
            },
          )
          social = features.includes('social')
          workos = features.includes('workos')
          clerk = features.includes('clerk')

          if (social) {
            const providerMode = await promptChoice<AuthSocialProviderMode>(
              context,
              'Social provider setup',
              AUTH_SOCIAL_PROVIDER_MODES,
              'default',
              {
                labels: {
                  default: 'Default social setup',
                  specific: 'Choose specific providers',
                },
              },
            )

            if (providerMode === 'specific') {
              socialProviders = [
                ...(await promptMultiChoice<SupportedAuthSocialProvider>(
                  context,
                  'Social providers',
                  SUPPORTED_AUTH_SOCIAL_PROVIDERS,
                  { required: true },
                )),
              ]
            }
          }
        }

        return {
          args: [target],
          flags: {
            ...(driver ? { driver } : {}),
            ...(social ? { social } : {}),
            ...(socialProviders.length > 0 ? { provider: socialProviders } : {}),
            ...(workos ? { workos } : {}),
            /* v8 ignore next -- exercised only by the install-command prepare path with a clerk flag */
            ...(clerk ? { clerk } : {}),
          },
        }
      },
      async run(commandContext) {
        const target = String(commandContext.args[0] ?? '')

        if (target === 'events') {
          const {
            installEventsIntoProject,
            installQueueIntoProject,
          } = await loadProjectScaffoldModule()
          const queueConfigured = await hasProjectDependency(context.projectRoot, '@holo-js/queue')
            || await fileExists(resolve(context.projectRoot, 'config/queue.ts'))
            || await fileExists(resolve(context.projectRoot, 'config/queue.mts'))
            || await fileExists(resolve(context.projectRoot, 'config/queue.js'))
            || await fileExists(resolve(context.projectRoot, 'config/queue.mjs'))
          const eventsResult = await installEventsIntoProject(context.projectRoot)
          let queueResult:
            | Awaited<ReturnType<typeof ProjectScaffoldModule.installQueueIntoProject>>
            | undefined

          if (
            !queueConfigured
            && isInteractive(context, commandContext.flags as Record<string, string | boolean | readonly string[]>)
          ) {
            const queueAction = await promptChoice<EventsQueueAction>(
              context,
              'Queued listeners',
              EVENTS_QUEUE_ACTIONS,
              'skip',
              {
                labels: {
                  skip: 'Skip queued listeners',
                  enable: 'Enable queued listeners',
                },
              },
            )

            if (queueAction === 'enable') {
              queueResult = await installQueueIntoProject(context.projectRoot, { driver: 'sync' })
            }
          }

          const changed = eventsResult.updatedPackageJson
            || eventsResult.createdEventsDirectory
            || eventsResult.createdListenersDirectory
            || Boolean(queueResult)

          writeLine(context.stdout, changed ? 'Installed events support.' : 'Events support is already installed.')
          if (eventsResult.updatedPackageJson || queueResult?.updatedPackageJson) writeLine(context.stdout, '  - updated package.json')
          if (eventsResult.createdEventsDirectory) writeLine(context.stdout, '  - created server/events')
          if (eventsResult.createdListenersDirectory) writeLine(context.stdout, '  - created server/listeners')
          if (queueResult) {
            writeLine(context.stdout, '  - enabled queued listeners')
            if (queueResult.createdQueueConfig) writeLine(context.stdout, '  - created config/queue.ts')
            /* v8 ignore next 2 -- queued listeners are auto-enabled with the sync driver in this flow */
            if (queueResult.updatedEnv) writeLine(context.stdout, '  - updated .env')
            /* v8 ignore next 2 -- queued listeners are auto-enabled with the sync driver in this flow */
            if (queueResult.updatedEnvExample) writeLine(context.stdout, '  - updated .env.example')
            if (queueResult.createdJobsDirectory) writeLine(context.stdout, '  - created server/jobs')
          }
          await runProjectDependencyInstallAfterPackageJsonUpdate(
            context,
            projectExecutors,
            eventsResult.updatedPackageJson || queueResult?.updatedPackageJson === true,
          )
          return
        }

        if (target === 'auth') {
          const { installAuthIntoProject } = await loadProjectScaffoldModule()
          const socialProviders = ((collectMultiStringFlag(commandContext.flags, 'provider') ?? [])
            .flatMap(entry => splitCsv(entry) ?? [])
            .map(provider => normalizeChoice(provider, SUPPORTED_AUTH_SOCIAL_PROVIDERS, 'auth social provider')) as SupportedAuthSocialProvider[])
          const result = await installAuthIntoProject(context.projectRoot, {
            social: commandContext.flags.social === true,
            ...(socialProviders.length > 0 ? { socialProviders } : {}),
            workos: commandContext.flags.workos === true,
            clerk: commandContext.flags.clerk === true,
          })
          const changed = result.updatedPackageJson
            || result.createdAuthConfig
            || result.createdSessionConfig
            || result.createdSecurityConfig
            || result.createdCorsConfig
            || result.createdUserModel
            || result.createdMigrationFiles.length > 0
            || result.updatedEnv
            || result.updatedEnvExample

          writeLine(context.stdout, changed ? 'Installed auth support.' : 'Auth support is already installed.')
          if (result.updatedPackageJson) writeLine(context.stdout, '  - updated package.json')
          if (result.createdAuthConfig) writeLine(context.stdout, '  - created config/auth.ts')
          if (result.createdSessionConfig) writeLine(context.stdout, '  - created config/session.ts')
          if (result.createdSecurityConfig) writeLine(context.stdout, '  - created config/security.ts')
          if (result.createdCorsConfig) writeLine(context.stdout, '  - created config/cors.ts')
          if (result.createdUserModel) writeLine(context.stdout, '  - created server/models/User.ts')
          if (result.updatedEnv) writeLine(context.stdout, '  - updated .env')
          if (result.updatedEnvExample) writeLine(context.stdout, '  - updated .env.example')
          if (result.createdMigrationFiles.length > 0) writeLine(context.stdout, `  - created ${result.createdMigrationFiles.length} auth migrations`)
          await runProjectDependencyInstallAfterPackageJsonUpdate(context, projectExecutors, result.updatedPackageJson)
          return
        }

        if (target === 'authorization') {
          const { installAuthorizationIntoProject } = await loadProjectScaffoldModule()
          const result = await installAuthorizationIntoProject(context.projectRoot)
          const changed = result.updatedPackageJson
            || result.createdPoliciesDirectory
            || result.createdAbilitiesDirectory
            || result.createdPoliciesReadme
            || result.createdAbilitiesReadme

          writeLine(context.stdout, changed ? 'Installed authorization support.' : 'Authorization support is already installed.')
          if (result.updatedPackageJson) writeLine(context.stdout, '  - updated package.json')
          if (result.createdPoliciesDirectory) writeLine(context.stdout, '  - created server/policies')
          if (result.createdAbilitiesDirectory) writeLine(context.stdout, '  - created server/abilities')
          if (result.createdPoliciesReadme) writeLine(context.stdout, '  - created server/policies/README.md')
          if (result.createdAbilitiesReadme) writeLine(context.stdout, '  - created server/abilities/README.md')
          await runProjectDependencyInstallAfterPackageJsonUpdate(context, projectExecutors, result.updatedPackageJson)
          return
        }

        if (target === 'notifications') {
          const { installNotificationsIntoProject } = await loadProjectScaffoldModule()
          const result = await installNotificationsIntoProject(context.projectRoot)
          const changed = result.updatedPackageJson
            || result.createdNotificationsConfig
            || result.createdMigrationFiles.length > 0

          writeLine(context.stdout, changed ? 'Installed notifications support.' : 'Notifications support is already installed.')
          if (result.updatedPackageJson) writeLine(context.stdout, '  - updated package.json')
          if (result.createdNotificationsConfig) writeLine(context.stdout, '  - created config/notifications.ts')
          if (result.createdMigrationFiles.length > 0) {
            writeLine(context.stdout, `  - created ${result.createdMigrationFiles.length} notifications migration`)
          }
          await runProjectDependencyInstallAfterPackageJsonUpdate(context, projectExecutors, result.updatedPackageJson)
          return
        }

        if (target === 'mail') {
          const { installMailIntoProject } = await loadProjectScaffoldModule()
          const result = await installMailIntoProject(context.projectRoot)
          const changed = result.updatedPackageJson
            || result.createdMailConfig
            || result.createdMailDirectory
            || result.updatedEnv
            || result.updatedEnvExample

          writeLine(context.stdout, changed ? 'Installed mail support.' : 'Mail support is already installed.')
          if (result.updatedPackageJson) writeLine(context.stdout, '  - updated package.json')
          if (result.updatedEnv) writeLine(context.stdout, '  - updated .env')
          if (result.updatedEnvExample) writeLine(context.stdout, '  - updated .env.example')
          if (result.createdMailConfig) writeLine(context.stdout, '  - created config/mail.ts')
          if (result.createdMailDirectory) writeLine(context.stdout, '  - created server/mail')
          await runProjectDependencyInstallAfterPackageJsonUpdate(context, projectExecutors, result.updatedPackageJson)
          return
        }

        if (target === 'broadcast') {
          const { installBroadcastIntoProject } = await loadProjectScaffoldModule()
          const result = await installBroadcastIntoProject(context.projectRoot)
          const changed = result.updatedPackageJson
            || result.createdBroadcastConfig
            || result.createdBroadcastDirectory
            || result.createdChannelsDirectory
            || result.createdBroadcastAuthRoute
            || result.createdFrameworkSetup
            || result.updatedEnv
            || result.updatedEnvExample

          writeLine(context.stdout, changed ? 'Installed broadcast support.' : 'Broadcast support is already installed.')
          if (result.updatedPackageJson) writeLine(context.stdout, '  - updated package.json')
          if (result.updatedEnv) writeLine(context.stdout, '  - updated .env')
          if (result.updatedEnvExample) writeLine(context.stdout, '  - updated .env.example')
          if (result.createdBroadcastConfig) writeLine(context.stdout, '  - created config/broadcast.ts')
          if (result.createdBroadcastDirectory) writeLine(context.stdout, '  - created server/broadcast')
          if (result.createdChannelsDirectory) writeLine(context.stdout, '  - created server/channels')
          if (result.createdBroadcastAuthRoute) writeLine(context.stdout, '  - created /broadcasting/auth route')
          if (result.createdFrameworkSetup) writeLine(context.stdout, '  - created framework Flux setup')
          await runProjectDependencyInstallAfterPackageJsonUpdate(context, projectExecutors, result.updatedPackageJson)
          return
        }

        if (target === 'realtime') {
          const { installRealtimeIntoProject } = await loadProjectScaffoldModule()
          const result = await installRealtimeIntoProject(context.projectRoot)
          const changed = result.updatedPackageJson || result.createdRealtimeDirectory || result.createdFrameworkSetup

          writeLine(context.stdout, changed ? 'Installed realtime support.' : 'Realtime support is already installed.')
          if (result.updatedPackageJson) writeLine(context.stdout, '  - updated package.json')
          if (result.createdRealtimeDirectory) writeLine(context.stdout, '  - created server/realtime')
          if (result.createdFrameworkSetup) writeLine(context.stdout, '  - created realtime framework setup')
          await runProjectDependencyInstallAfterPackageJsonUpdate(context, projectExecutors, result.updatedPackageJson)
          return
        }

        if (target === 'security') {
          const { installSecurityIntoProject } = await loadProjectScaffoldModule()
          const result = await installSecurityIntoProject(context.projectRoot)
          const changed = result.updatedPackageJson || result.createdSecurityConfig || result.createdCorsConfig

          writeLine(context.stdout, changed ? 'Installed security support.' : 'Security support is already installed.')
          if (result.updatedPackageJson) writeLine(context.stdout, '  - updated package.json')
          if (result.createdSecurityConfig) writeLine(context.stdout, '  - created config/security.ts')
          if (result.createdCorsConfig) writeLine(context.stdout, '  - created config/cors.ts')
          await runProjectDependencyInstallAfterPackageJsonUpdate(context, projectExecutors, result.updatedPackageJson)
          return
        }

        if (target === 'cache') {
          const { installCacheIntoProject } = await loadProjectScaffoldModule()
          const result = await installCacheIntoProject(context.projectRoot, {
            driver: String(commandContext.flags.driver ?? 'file') as SupportedCacheInstallerDriver,
          })

          const changed = result.createdCacheConfig
            || result.createdRedisConfig
            || result.updatedPackageJson
            || result.updatedEnv
            || result.updatedEnvExample

          writeLine(context.stdout, changed ? 'Installed cache support.' : 'Cache support is already installed.')
          if (result.createdCacheConfig) writeLine(context.stdout, '  - created config/cache.ts')
          if (result.createdRedisConfig) writeLine(context.stdout, '  - created config/redis.ts')
          if (result.updatedPackageJson) writeLine(context.stdout, '  - updated package.json')
          if (result.updatedEnv) writeLine(context.stdout, '  - updated .env')
          if (result.updatedEnvExample) writeLine(context.stdout, '  - updated .env.example')
          if (result.databaseDriver) writeLine(context.stdout, '  - run "holo cache:table" to create the cache tables')
          await runProjectDependencyInstallAfterPackageJsonUpdate(context, projectExecutors, result.updatedPackageJson)
          return
        }

        if (target === 'media') {
          const { installMediaIntoProject } = await loadProjectScaffoldModule()
          const result = await installMediaIntoProject(context.projectRoot)

          const changed = result.createdMediaConfig
            || result.updatedPackageJson
            || result.createdMigrationFiles.length > 0

          writeLine(context.stdout, changed ? 'Installed media support.' : 'Media support is already installed.')
          if (result.createdMediaConfig) writeLine(context.stdout, '  - created config/media.ts')
          if (result.updatedPackageJson) writeLine(context.stdout, '  - updated package.json')
          if (result.createdMigrationFiles.length > 0) writeLine(context.stdout, '  - created media migration')
          await runProjectDependencyInstallAfterPackageJsonUpdate(context, projectExecutors, result.updatedPackageJson)
          return
        }

        if (target !== 'queue') {
          throw new Error(`Unsupported install target: ${target || '(empty)'}.`)
        }

        const { installQueueIntoProject } = await loadProjectScaffoldModule()
        const result = await installQueueIntoProject(context.projectRoot, {
          driver: String(commandContext.flags.driver ?? 'sync') as SupportedQueueInstallerDriver,
        })

        const changed = result.createdQueueConfig
          || result.updatedPackageJson
          || result.updatedEnv
          || result.updatedEnvExample
          || result.createdJobsDirectory

        writeLine(context.stdout, changed ? 'Installed queue support.' : 'Queue support is already installed.')
        if (result.createdQueueConfig) writeLine(context.stdout, '  - created config/queue.ts')
        if (result.updatedPackageJson) writeLine(context.stdout, '  - updated package.json')
        if (result.updatedEnv) writeLine(context.stdout, '  - updated .env')
        if (result.updatedEnvExample) writeLine(context.stdout, '  - updated .env.example')
        if (result.createdJobsDirectory) writeLine(context.stdout, '  - created server/jobs')
        await runProjectDependencyInstallAfterPackageJsonUpdate(context, projectExecutors, result.updatedPackageJson)
      },
    },
    {
      name: 'plugin:add',
      aliases: ['plugins:add'],
      description: 'Install and activate a Holo plugin package.',
      usage: 'holo plugin:add <package>',
      source: 'internal',
      async prepare(input) {
        const packageName = await ensureRequiredArg(context, input, 0, 'Plugin package')
        return { args: [packageName], flags: {} }
      },
      async run(commandContext) {
        const packageName = String(commandContext.args[0] ?? '')
        const plugins = await loadProjectPluginsModule()
        const packageJsonSnapshot = await readPackageJsonSnapshot(context.projectRoot)
        const appConfigSnapshot = await readAppConfigSnapshot(context.projectRoot)
        const holoDirectorySnapshot = await readDirectorySnapshot(context.projectRoot, '.holo-js')
        let dependencyInstallSucceeded = false
        let updatedDependencies = false
        let updatedPackageJson = false
        let loadedPlugin: ProjectPluginsModule.LoadedHoloPlugin
        let contributedDependencies: readonly string[] = []
        let updatedContributedDependencies = false
        let activated = false
        let createdSecurityConfig = false
        let securityScaffoldSnapshots: DirectorySnapshot[] = []

        try {
          updatedPackageJson = await upsertProjectDependency(context.projectRoot, packageName)
          updatedDependencies = updatedPackageJson || updatedDependencies

          if (updatedPackageJson) {
            await runProjectDependencyInstallForProject(context, projectExecutors, context.projectRoot)
            dependencyInstallSucceeded = true
            await pinProjectDependencyVersions(context.projectRoot, [packageName])
          }

          loadedPlugin = await plugins.loadHoloPluginFromPackage(context.projectRoot, packageName)

          contributedDependencies = [
            ...(loadedPlugin.definition.contributes?.dependencies?.holo ?? []),
            ...(loadedPlugin.definition.contributes?.dependencies?.runtime ?? []),
          ]

          for (const dependencyName of contributedDependencies) {
            const updatedContributedDependency = await upsertProjectDependency(context.projectRoot, dependencyName)
            updatedContributedDependencies = updatedContributedDependency
              || updatedContributedDependencies
          }
          updatedDependencies = updatedContributedDependencies || updatedDependencies

          if (updatedContributedDependencies) {
            await runProjectDependencyInstallForProject(context, projectExecutors, context.projectRoot)
            dependencyInstallSucceeded = true
            await pinProjectDependencyVersions(context.projectRoot, contributedDependencies)
          }

          if (contributedDependencies.includes('@holo-js/security')) {
            securityScaffoldSnapshots = await Promise.all([
              readDirectorySnapshot(context.projectRoot, 'config'),
              readDirectorySnapshot(context.projectRoot, 'storage/framework/rate-limits'),
            ])
            const installSecurityIntoProject = projectExecutors.installSecurityIntoProject
              ?? (await loadProjectScaffoldModule()).installSecurityIntoProject
            const securityResult = await installSecurityIntoProject(context.projectRoot)
            createdSecurityConfig = securityResult.createdSecurityConfig
          }

          activated = await plugins.activateProjectPlugin(context.projectRoot, packageName)

          if (activated) {
            const runProjectPrepare = await resolveProjectExecutor(projectExecutors, 'runProjectPrepare')
            await runProjectPrepare(context.projectRoot, context)
          }
        } catch (error) {
          await restoreAppConfigSnapshot(appConfigSnapshot)
          await restorePackageJsonSnapshot(context.projectRoot, packageJsonSnapshot)
          await restoreDirectorySnapshot(holoDirectorySnapshot)
          await Promise.all(securityScaffoldSnapshots.map(restoreDirectorySnapshot))
          if (updatedDependencies && dependencyInstallSucceeded) {
            await runProjectDependencyInstallForProject(context, projectExecutors, context.projectRoot).catch(() => undefined)
          }
          await cleanupDirectorySnapshot(holoDirectorySnapshot)
          await Promise.all(securityScaffoldSnapshots.map(cleanupDirectorySnapshot))

          throw error
        }

        writeLine(context.stdout, `Installed Holo plugin: ${formatPluginLabel(loadedPlugin.definition)}`)
        writeLine(context.stdout, `  - package: ${updatedPackageJson ? 'added' : 'already present'} ${packageName}`)
        if (contributedDependencies.length > 0) {
          writeLine(
            context.stdout,
            `  - dependencies: ${updatedContributedDependencies ? 'updated' : 'already present'} ${contributedDependencies.join(', ')}`,
          )
        }
        writeLine(context.stdout, `  - activation: ${activated ? 'updated config/app.ts' : 'already active'}`)
        if (activated) {
          writeLine(context.stdout, '  - refreshed generated artifacts')
        }
        if (createdSecurityConfig) {
          writeLine(context.stdout, '  - created config/security.ts')
        }

        for (const line of formatPluginContributionLines(loadedPlugin.definition)) {
          writeLine(context.stdout, `  - ${line}`)
        }
        await cleanupDirectorySnapshot(holoDirectorySnapshot)
        await Promise.all(securityScaffoldSnapshots.map(cleanupDirectorySnapshot))
      },
    },
    {
      name: 'plugin:list',
      aliases: ['plugins:list'],
      description: 'List active Holo plugins.',
      usage: 'holo plugin:list',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        const plugins = await loadProjectPluginsModule()
        const resolvedPlugins = await plugins.resolveProjectPlugins(context.projectRoot)

        writeLine(context.stdout, 'Active Holo plugins:')
        if (resolvedPlugins.length === 0) {
          writeLine(context.stdout, '  (none)')
          return
        }

        for (const resolvedPlugin of resolvedPlugins) {
          if (resolvedPlugin.loaded) {
            writeLine(context.stdout, `  - ${resolvedPlugin.packageName}: ${formatPluginLabel(resolvedPlugin.loaded.definition)}`)
            continue
          }

          writeLine(context.stdout, `  - ${resolvedPlugin.packageName}: failed`)
          if (resolvedPlugin.error) {
            writeLine(context.stdout, `    ${resolvedPlugin.error}`)
          }
        }
      },
    },
    {
      name: 'plugin:remove',
      aliases: ['plugins:remove'],
      description: 'Deactivate a Holo plugin package.',
      usage: 'holo plugin:remove <package> [--uninstall]',
      source: 'internal',
      async prepare(input) {
        const packageName = await ensureRequiredArg(context, input, 0, 'Plugin package')
        return {
          args: [packageName],
          flags: {
            ...(resolveBooleanFlag(input.flags, 'uninstall') === true ? { uninstall: true } : {}),
          },
        }
      },
      async run(commandContext) {
        const packageName = String(commandContext.args[0] ?? '')
        const plugins = await loadProjectPluginsModule()
        const deactivated = await plugins.deactivateProjectPlugin(context.projectRoot, packageName)
        const uninstalled = commandContext.flags.uninstall === true
          ? await removeProjectDependency(context.projectRoot, packageName)
          : false

        if (uninstalled) {
          await runProjectDependencyInstallForProject(context, projectExecutors, context.projectRoot)
        }

        if (deactivated || uninstalled) {
          const runProjectPrepare = await resolveProjectExecutor(projectExecutors, 'runProjectPrepare')
          await runProjectPrepare(context.projectRoot, context)
        }

        writeLine(context.stdout, deactivated ? 'Removed Holo plugin activation.' : 'Holo plugin was not active.')
        writeLine(context.stdout, `  - package: ${packageName}`)
        if (commandContext.flags.uninstall === true) {
          writeLine(context.stdout, `  - dependency: ${uninstalled ? 'removed from package.json' : 'not present in package.json'}`)
        } else {
          writeLine(context.stdout, '  - dependency: left installed')
        }
      },
    },
    {
      name: 'plugin:info',
      aliases: ['plugins:info'],
      description: 'Show metadata for a Holo plugin package.',
      usage: 'holo plugin:info <package>',
      source: 'internal',
      async prepare(input) {
        const packageName = await ensureRequiredArg(context, input, 0, 'Plugin package')
        return { args: [packageName], flags: {} }
      },
      async run(commandContext) {
        const packageName = String(commandContext.args[0] ?? '')
        const plugins = await loadProjectPluginsModule()
        const loadedPlugin = await plugins.loadHoloPluginFromPackage(context.projectRoot, packageName)

        writePluginDetails(context, loadedPlugin)
      },
    },
    {
      name: 'plugin:doctor',
      aliases: ['plugins:doctor'],
      description: 'Validate active Holo plugin packages.',
      usage: 'holo plugin:doctor',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        const plugins = await loadProjectPluginsModule()
        const resolvedPlugins = await plugins.resolveProjectPlugins(context.projectRoot)
        const failedPlugins = resolvedPlugins.filter(resolvedPlugin => !resolvedPlugin.loaded)

        if (resolvedPlugins.length === 0) {
          writeLine(context.stdout, 'No active Holo plugins.')
          return
        }

        if (failedPlugins.length === 0) {
          await plugins.loadProjectPluginPreparers(context.projectRoot)
        }

        for (const resolvedPlugin of resolvedPlugins) {
          if (resolvedPlugin.loaded) {
            writeLine(context.stdout, `Loaded ${resolvedPlugin.packageName}: ${formatPluginLabel(resolvedPlugin.loaded.definition)}`)
            continue
          }

          writeLine(context.stdout, `Failed ${resolvedPlugin.packageName}: ${resolvedPlugin.error ?? 'Unknown plugin loading error.'}`)
        }

        if (failedPlugins.length > 0) {
          throw new Error(`${failedPlugins.length} Holo ${failedPlugins.length === 1 ? 'plugin' : 'plugins'} failed validation.`)
        }
      },
    },
    {
      name: 'auth:notifications:publish',
      description: 'Publish editable auth notification definitions into the application.',
      usage: 'holo auth:notifications:publish',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        const { publishAuthNotificationsIntoProject } = await loadProjectScaffoldModule()
        const result = await publishAuthNotificationsIntoProject(context.projectRoot)
        const changed = result.createdFiles.length > 0

        writeLine(context.stdout, changed
          ? 'Published auth notification files.'
          : 'Auth notification files are already published.')

        for (const filePath of result.createdFiles) {
          writeLine(context.stdout, `  - created ${filePath}`)
        }

        for (const filePath of result.skippedFiles) {
          writeLine(context.stdout, `  - skipped existing ${filePath}`)
        }

        if (!result.hasMailDependency) {
          writeLine(
            context.stdout,
            '  - note: install @holo-js/mail or configure a notification mailer before email delivery can send.',
          )
        }
      },
    },
    {
      name: 'prepare',
      description: 'Discover Holo resources and refresh generated registries.',
      usage: 'holo prepare',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        const runProjectPrepare = await resolveProjectExecutor(projectExecutors, 'runProjectPrepare')
        await runProjectPrepare(context.projectRoot, context, { command: 'prepare', reason: 'explicit' })
        writeLine(context.stdout, 'Prepared Holo discovery artifacts.')
      },
    },
    {
      name: 'dev',
      description: 'Prepare Holo discovery artifacts and run the project dev script.',
      usage: 'holo dev',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        const runProjectDevServer = await resolveProjectExecutor(projectExecutors, 'runProjectDevServer')
        await runProjectDevServer(context, context.projectRoot)
      },
    },
    {
      name: 'build',
      description: 'Prepare Holo discovery artifacts and run the project build script.',
      usage: 'holo build [...frameworkArgs]',
      source: 'internal',
      async prepare(input) {
        return { args: input.args, flags: input.flags }
      },
      async run(input) {
        const prepareProjectSchema = await resolveProjectExecutor(projectExecutors, 'prepareProjectSchema')
        const runProjectBuildPrepare = await resolveProjectExecutor(projectExecutors, 'runProjectBuildPrepare')
        const runProjectBuild = await resolveProjectExecutor(projectExecutors, 'runProjectBuild')
        const executeRuntime = await resolveRuntimeExecutor(runtimeExecutor)
        await prepareProjectSchema(context.projectRoot)
        await executeRuntime(context.projectRoot, 'hydrate-schema', {}, async () => undefined)
        await runProjectBuildPrepare(context, context.projectRoot)
        const passthroughArgs = serializePassthroughInput(input)
        if (passthroughArgs.length > 0) {
          await runProjectBuild(context, context.projectRoot, undefined, passthroughArgs)
          return
        }

        await runProjectBuild(context, context.projectRoot)
      },
    },
    {
      name: 'start',
      description: 'Run the production framework server with Holo runtime preloads.',
      usage: 'holo start [...frameworkArgs]',
      source: 'internal',
      async prepare(input) {
        return { args: input.args, flags: input.flags }
      },
      async run(input) {
        const runProjectStartServer = await resolveProjectExecutor(projectExecutors, 'runProjectStartServer')
        const passthroughArgs = serializePassthroughInput(input)
        if (passthroughArgs.length > 0) {
          await runProjectStartServer(context, context.projectRoot, undefined, passthroughArgs)
          return
        }

        await runProjectStartServer(context, context.projectRoot)
      },
    },
    {
      name: 'broadcast:work',
      description: 'Run the self-hosted broadcast worker.',
      usage: 'holo broadcast:work',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        const runBroadcastWorkCommand = await resolveBroadcastExecutor(broadcastExecutors, 'runBroadcastWorkCommand')
        await runBroadcastWorkCommand(context, context.projectRoot)
      },
    },
    {
      name: 'cache:table',
      description: 'Generate the database cache table migration.',
      usage: 'holo cache:table',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        const runCacheTableCommand = await resolveCacheExecutor(cacheExecutors, 'runCacheTableCommand')
        await runCacheTableCommand(context, context.projectRoot)
      },
    },
    {
      name: 'cache:clear',
      description: 'Clear the configured cache store.',
      usage: 'holo cache:clear [--driver <name>]',
      source: 'internal',
      async prepare(input) {
        const driver = resolveStringFlag(input.flags, 'driver', 'd')
        return {
          args: [],
          flags: {
            ...(driver ? { driver } : {}),
          },
        }
      },
      async run(commandContext) {
        const runCacheClearCommand = await resolveCacheExecutor(cacheExecutors, 'runCacheClearCommand')
        await runCacheClearCommand(
          context,
          context.projectRoot,
          typeof commandContext.flags.driver === 'string' ? commandContext.flags.driver : undefined,
        )
      },
    },
    {
      name: 'cache:forget',
      description: 'Forget a single cache key.',
      usage: 'holo cache:forget <key> [--driver <name>]',
      source: 'internal',
      async prepare(input) {
        const key = await ensureRequiredArg(context, input, 0, 'Cache key')
        const driver = resolveStringFlag(input.flags, 'driver', 'd')
        return {
          args: [key],
          flags: {
            ...(driver ? { driver } : {}),
          },
        }
      },
      async run(commandContext) {
        const runCacheForgetCommand = await resolveCacheExecutor(cacheExecutors, 'runCacheForgetCommand')
        await runCacheForgetCommand(
          context,
          context.projectRoot,
          String(commandContext.args[0] ?? ''),
          typeof commandContext.flags.driver === 'string' ? commandContext.flags.driver : undefined,
        )
      },
    },
    {
      name: 'media:table',
      description: 'Generate the media table migration.',
      usage: 'holo media:table',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        const runMediaTableCommand = await resolveMediaExecutor(mediaExecutors, 'runMediaTableCommand')
        await runMediaTableCommand(context, context.projectRoot)
      },
    },
    {
      name: 'queue:table',
      description: 'Generate the database queue jobs table migration.',
      usage: 'holo queue:table',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        const runQueueTableCommand = await resolveQueueExecutor(queueExecutors, 'runQueueTableCommand')
        await runQueueTableCommand(context, context.projectRoot)
      },
    },
    {
      name: 'queue:failed-table',
      description: 'Generate the failed jobs table migration.',
      usage: 'holo queue:failed-table',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        const runQueueFailedTableCommand = await resolveQueueExecutor(queueExecutors, 'runQueueFailedTableCommand')
        await runQueueFailedTableCommand(context, context.projectRoot)
      },
    },
    {
      name: 'queue:work',
      description: 'Run the queue worker for an async queue connection.',
      usage: 'holo queue:work [--connection <name>] [--queue <name>] [--once] [--stop-when-empty] [--sleep N] [--tries N] [--timeout N] [--max-jobs N] [--max-time N]',
      source: 'internal',
      async prepare(input) {
        const connection = resolveStringFlag(input.flags, 'connection', 'c')
        const queueNames = (collectMultiStringFlag(input.flags, 'queue', 'q') ?? []).flatMap(entry => splitCsv(entry))
        const sleep = parseNumberFlag(input.flags, 'sleep')
        const tries = parseNumberFlag(input.flags, 'tries')
        const timeout = parseNumberFlag(input.flags, 'timeout')
        const maxJobs = parseNumberFlag(input.flags, 'max-jobs')
        const maxTime = parseNumberFlag(input.flags, 'max-time')
        return {
          args: [],
          flags: {
            ...(connection ? { connection } : {}),
            ...(queueNames && queueNames.length > 0 ? { queue: queueNames } : {}),
            once: resolveBooleanFlag(input.flags, 'once'),
            ['stop-when-empty']: resolveBooleanFlag(input.flags, 'stop-when-empty'),
            ...(typeof sleep === 'number' ? { sleep } : {}),
            ...(typeof tries === 'number' ? { tries } : {}),
            ...(typeof timeout === 'number' ? { timeout } : {}),
            ...(typeof maxJobs === 'number' ? { ['max-jobs']: maxJobs } : {}),
            ...(typeof maxTime === 'number' ? { ['max-time']: maxTime } : {}),
          },
        }
      },
      async run(commandContext) {
        const runQueueWorkCommand = await resolveQueueExecutor(queueExecutors, 'runQueueWorkCommand')
        await runQueueWorkCommand(context, context.projectRoot, {
          ...(typeof commandContext.flags.connection === 'string' ? { connection: commandContext.flags.connection } : {}),
          ...(Array.isArray(commandContext.flags.queue) ? { queueNames: commandContext.flags.queue } : {}),
          once: commandContext.flags.once === true,
          stopWhenEmpty: commandContext.flags['stop-when-empty'] === true,
          ...(typeof commandContext.flags.sleep === 'number' ? { sleep: commandContext.flags.sleep } : {}),
          ...(typeof commandContext.flags.tries === 'number' ? { tries: commandContext.flags.tries } : {}),
          ...(typeof commandContext.flags.timeout === 'number' ? { timeout: commandContext.flags.timeout } : {}),
          ...(typeof commandContext.flags['max-jobs'] === 'number' ? { maxJobs: commandContext.flags['max-jobs'] } : {}),
          ...(typeof commandContext.flags['max-time'] === 'number' ? { maxTime: commandContext.flags['max-time'] } : {}),
        })
      },
    },
    {
      name: 'queue:listen',
      description: 'Watch queue-related project files and restart the queue worker on change.',
      usage: 'holo queue:listen [--connection <name>] [--queue <name>] [--sleep N] [--tries N] [--timeout N] [--max-jobs N] [--max-time N]',
      source: 'internal',
      async prepare(input) {
        const connection = resolveStringFlag(input.flags, 'connection', 'c')
        const queueNames = (collectMultiStringFlag(input.flags, 'queue', 'q') ?? []).flatMap(entry => splitCsv(entry))
        const sleep = parseNumberFlag(input.flags, 'sleep')
        const tries = parseNumberFlag(input.flags, 'tries')
        const timeout = parseNumberFlag(input.flags, 'timeout')
        const maxJobs = parseNumberFlag(input.flags, 'max-jobs')
        const maxTime = parseNumberFlag(input.flags, 'max-time')
        return {
          args: [],
          flags: {
            ...(connection ? { connection } : {}),
            ...(queueNames && queueNames.length > 0 ? { queue: queueNames } : {}),
            ...(typeof sleep === 'number' ? { sleep } : {}),
            ...(typeof tries === 'number' ? { tries } : {}),
            ...(typeof timeout === 'number' ? { timeout } : {}),
            ...(typeof maxJobs === 'number' ? { ['max-jobs']: maxJobs } : {}),
            ...(typeof maxTime === 'number' ? { ['max-time']: maxTime } : {}),
          },
        }
      },
      async run(commandContext) {
        const runQueueListen = await resolveQueueExecutor(queueExecutors, 'runQueueListen')
        await runQueueListen(context, context.projectRoot, commandContext.flags)
      },
    },
    {
      name: 'rate-limit:clear',
      description: 'Clear rate-limit buckets for the configured security driver.',
      usage: 'holo rate-limit:clear [--limiter <name>] [--key <value>] [--all]',
      source: 'internal',
      async prepare(input) {
        const limiter = resolveStringFlag(input.flags, 'limiter')
        const key = resolveStringFlag(input.flags, 'key')
        const all = resolveBooleanFlag(input.flags, 'all')

        if (!all && !limiter) {
          throw new Error('rate-limit:clear requires --limiter <name> unless --all is used.')
        }

        return {
          args: [],
          flags: {
            ...(limiter ? { limiter } : {}),
            ...(key ? { key } : {}),
            ...(all ? { all } : {}),
          },
        }
      },
      async run(commandContext) {
        const runRateLimitClearCommand = securityExecutors.runRateLimitClearCommand
          ?? (await loadSecurityModule()).runRateLimitClearCommand

        await runRateLimitClearCommand(context, context.projectRoot, {
          ...(typeof commandContext.flags.limiter === 'string' ? { limiter: commandContext.flags.limiter } : {}),
          ...(typeof commandContext.flags.key === 'string' ? { key: commandContext.flags.key } : {}),
          ...(commandContext.flags.all === true ? { all: true } : {}),
        })
      },
    },
    {
      name: 'queue:restart',
      description: 'Signal long-lived queue workers to restart after the current job.',
      usage: 'holo queue:restart',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        const runQueueRestartCommand = await resolveQueueExecutor(queueExecutors, 'runQueueRestartCommand')
        await runQueueRestartCommand(context, context.projectRoot)
      },
    },
    {
      name: 'queue:clear',
      description: 'Clear pending jobs for a queue connection.',
      usage: 'holo queue:clear [--connection <name>] [--queue <name>]',
      source: 'internal',
      async prepare(input) {
        const connection = resolveStringFlag(input.flags, 'connection', 'c')
        const queueNames = (collectMultiStringFlag(input.flags, 'queue', 'q') ?? []).flatMap(entry => splitCsv(entry))
        return {
          args: [],
          flags: {
            ...(connection ? { connection } : {}),
            ...(queueNames && queueNames.length > 0 ? { queue: queueNames } : {}),
          },
        }
      },
      async run(commandContext) {
        const runQueueClearCommand = await resolveQueueExecutor(queueExecutors, 'runQueueClearCommand')
        await runQueueClearCommand(
          context,
          context.projectRoot,
          typeof commandContext.flags.connection === 'string' ? commandContext.flags.connection : undefined,
          Array.isArray(commandContext.flags.queue) ? commandContext.flags.queue : undefined,
        )
      },
    },
    {
      name: 'queue:failed',
      description: 'List failed queued jobs.',
      usage: 'holo queue:failed',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        const runQueueFailedCommand = await resolveQueueExecutor(queueExecutors, 'runQueueFailedCommand')
        await runQueueFailedCommand(context, context.projectRoot)
      },
    },
    {
      name: 'queue:retry',
      description: 'Retry one failed job or all failed jobs.',
      usage: 'holo queue:retry <id|all>',
      source: 'internal',
      async prepare(input) {
        const identifier = await ensureRequiredArg(context, input, 0, 'Failed job id')
        return {
          args: [identifier],
          flags: {},
        }
      },
      async run(commandContext) {
        const runQueueRetryCommand = await resolveQueueExecutor(queueExecutors, 'runQueueRetryCommand')
        await runQueueRetryCommand(
          context,
          context.projectRoot,
          String(commandContext.args[0] ?? ''),
        )
      },
    },
    {
      name: 'queue:forget',
      description: 'Delete one failed job record.',
      usage: 'holo queue:forget <id>',
      source: 'internal',
      async prepare(input) {
        const identifier = await ensureRequiredArg(context, input, 0, 'Failed job id')
        return {
          args: [identifier],
          flags: {},
        }
      },
      async run(commandContext) {
        const runQueueForgetCommand = await resolveQueueExecutor(queueExecutors, 'runQueueForgetCommand')
        await runQueueForgetCommand(
          context,
          context.projectRoot,
          String(commandContext.args[0] ?? ''),
        )
      },
    },
    {
      name: 'queue:flush',
      description: 'Clear the failed jobs table.',
      usage: 'holo queue:flush',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        const runQueueFlushCommand = await resolveQueueExecutor(queueExecutors, 'runQueueFlushCommand')
        await runQueueFlushCommand(context, context.projectRoot)
      },
    },
    {
      name: 'config:cache',
      description: 'Compile config files into a reusable cache artifact.',
      usage: 'holo config:cache',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        const { cacheProjectConfig } = await loadRuntimeModule()
        const cachePath = await cacheProjectConfig(context.projectRoot)
        writeLine(context.stdout, `Config cached: ${cachePath}`)
      },
    },
    {
      name: 'config:clear',
      description: 'Remove the generated config cache artifact.',
      usage: 'holo config:clear',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        const removed = await clearConfigCache(context.projectRoot)
        const cachePath = resolveConfigCachePath(context.projectRoot)
        writeLine(
          context.stdout,
          removed ? `Config cache cleared: ${cachePath}` : `Config cache was already clear: ${cachePath}`,
        )
      },
    },
    {
      name: 'make:model',
      description: 'Create a model and optionally related database artifacts.',
      usage: 'holo make:model <name> [--table <table>] [-m] [-o] [-s] [-f]',
      source: 'internal',
      async prepare(input) {
        const name = await ensureRequiredArg(context, input, 0, 'Model name')
        const table = resolveStringFlag(input.flags, 'table')
        const flags: PreparedInput['flags'] = {
          migration: resolveBooleanFlag(input.flags, 'migration', 'm'),
          observer: resolveBooleanFlag(input.flags, 'observer', 'o'),
          seeder: resolveBooleanFlag(input.flags, 'seeder', 's'),
          factory: resolveBooleanFlag(input.flags, 'factory', 'f'),
          ...(typeof table === 'string' ? { table } : {}),
        }

        /* v8 ignore start */
        if (isInteractive(context, input.flags)) {
          const noneSelected = [flags.migration, flags.observer, flags.seeder, flags.factory].every(value => value !== true)
          if (noneSelected) {
            const selectedArtifacts = await promptMultiChoice<ModelGeneratorOption>(
              context,
              'Model artifacts',
              MODEL_GENERATOR_OPTIONS,
              {
                initialValues: ['migration'],
                labels: {
                  migration: 'Migration',
                  observer: 'Observer',
                  seeder: 'Seeder',
                  factory: 'Factory',
                },
              },
            )

            flags.migration = selectedArtifacts.includes('migration')
            flags.observer = selectedArtifacts.includes('observer')
            flags.seeder = selectedArtifacts.includes('seeder')
            flags.factory = selectedArtifacts.includes('factory')
          }
        }
        /* v8 ignore stop */

        return {
          args: [name],
          flags,
        }
      },
      async run(commandContext) {
        const runMakeModel = await resolveGeneratorCommand('runMakeModel')
        await runMakeModel(context, context.projectRoot, {
          args: commandContext.args,
          flags: { ...commandContext.flags },
        })
      },
    },
    {
      name: 'make:migration',
      description: 'Create and register a migration file.',
      usage: 'holo make:migration <name> [--create users] [--table users]',
      source: 'internal',
      async prepare(input) {
        const create = resolveStringFlag(input.flags, 'create')
        const table = resolveStringFlag(input.flags, 'table')

        if (create && table) {
          throw new Error('Use either "--create" or "--table", not both.')
        }

        return {
          args: [await ensureRequiredArg(context, input, 0, 'Migration name')],
          flags: {
            ...(typeof create === 'string' ? { create } : {}),
            ...(typeof table === 'string' ? { table } : {}),
          },
        }
      },
      async run(commandContext) {
        const runMakeMigration = await resolveGeneratorCommand('runMakeMigration')
        await runMakeMigration(context, context.projectRoot, {
          args: commandContext.args,
          flags: { ...commandContext.flags },
        })
      },
    },
    {
      name: 'make:seeder',
      description: 'Create and register a seeder file.',
      usage: 'holo make:seeder <name>',
      source: 'internal',
      async prepare(input) {
        return {
          args: [await ensureRequiredArg(context, input, 0, 'Seeder name')],
          flags: {},
        }
      },
      async run(commandContext) {
        const runMakeSeeder = await resolveGeneratorCommand('runMakeSeeder')
        await runMakeSeeder(context, context.projectRoot, {
          args: commandContext.args,
          flags: { ...commandContext.flags },
        })
      },
    },
    {
      name: 'make:mail',
      description: 'Create a mail definition file.',
      usage: 'holo make:mail <name> [--markdown]',
      source: 'internal',
      async prepare(input) {
        const markdown = resolveBooleanFlag(input.flags, 'markdown') === true
        const view = resolveBooleanFlag(input.flags, 'view') === true

        if (markdown && view) {
          throw new Error('Use either "--markdown" or "--view", not both.')
        }

        if (view) {
          throw new Error(
            'View-backed mail scaffolding requires a renderView runtime binding, which the first-party app scaffolds do not configure yet. Use "--markdown" instead.',
          )
        }

        return {
          args: [await ensureRequiredArg(context, input, 0, 'Mail name')],
          flags: { type: 'markdown' },
        }
      },
      async run(commandContext) {
        const runMakeMail = await resolveGeneratorCommand('runMakeMail')
        await runMakeMail(context, context.projectRoot, {
          args: commandContext.args,
          flags: { ...commandContext.flags },
        })
      },
    },
    {
      name: 'make:event',
      description: 'Create and register an event file.',
      usage: 'holo make:event <name>',
      source: 'internal',
      async prepare(input) {
        return {
          args: [await ensureRequiredArg(context, input, 0, 'Event name')],
          flags: {},
        }
      },
      async run(commandContext) {
        const runMakeEvent = await resolveGeneratorCommand('runMakeEvent')
        await runMakeEvent(context, context.projectRoot, {
          args: commandContext.args,
          flags: { ...commandContext.flags },
        })
      },
    },
    {
      name: 'make:broadcast',
      description: 'Create and register a broadcast definition file.',
      usage: 'holo make:broadcast <name>',
      source: 'internal',
      async prepare(input) {
        return {
          args: [await ensureRequiredArg(context, input, 0, 'Broadcast name')],
          flags: {},
        }
      },
      async run(commandContext) {
        const runMakeBroadcast = await resolveGeneratorCommand('runMakeBroadcast')
        await runMakeBroadcast(context, context.projectRoot, {
          args: commandContext.args,
          flags: { ...commandContext.flags },
        })
      },
    },
    {
      name: 'make:channel',
      description: 'Create and register a channel authorization definition file.',
      usage: 'holo make:channel <pattern>',
      source: 'internal',
      async prepare(input) {
        return {
          args: [await ensureRequiredArg(context, input, 0, 'Channel pattern')],
          flags: {},
        }
      },
      async run(commandContext) {
        const runMakeChannel = await resolveGeneratorCommand('runMakeChannel')
        await runMakeChannel(context, context.projectRoot, {
          args: commandContext.args,
          flags: { ...commandContext.flags },
        })
      },
    },
    {
      name: 'make:job',
      description: 'Create and register a queue job file.',
      usage: 'holo make:job <name>',
      source: 'internal',
      async prepare(input) {
        return {
          args: [await ensureRequiredArg(context, input, 0, 'Job name')],
          flags: {},
        }
      },
      async run(commandContext) {
        const runMakeJob = await resolveGeneratorCommand('runMakeJob')
        await runMakeJob(context, context.projectRoot, {
          args: commandContext.args,
          flags: { ...commandContext.flags },
        })
      },
    },
    {
      name: 'make:listener',
      description: 'Create and register an event listener file.',
      usage: 'holo make:listener <name> --event <event-name> [--event <event-name>]',
      source: 'internal',
      async prepare(input) {
        const eventNames = (collectMultiStringFlag(input.flags, 'event') ?? [])
          .flatMap(entry => splitCsv(entry))
          .map(value => value.trim())
          .filter(Boolean)
        if (eventNames.length === 0) {
          throw new Error('Listener event name is required. Use "--event <event-name>".')
        }

        return {
          args: [await ensureRequiredArg(context, input, 0, 'Listener name')],
          flags: { event: eventNames },
        }
      },
      async run(commandContext) {
        const runMakeListener = await resolveGeneratorCommand('runMakeListener')
        await runMakeListener(context, context.projectRoot, {
          args: commandContext.args,
          flags: { ...commandContext.flags },
        })
      },
    },
    {
      name: 'make:observer',
      description: 'Create an observer file.',
      usage: 'holo make:observer <name>',
      source: 'internal',
      async prepare(input) {
        return {
          args: [await ensureRequiredArg(context, input, 0, 'Observer name')],
          flags: {},
        }
      },
      async run(commandContext) {
        const runMakeObserver = await resolveGeneratorCommand('runMakeObserver')
        await runMakeObserver(context, context.projectRoot, {
          args: commandContext.args,
          flags: { ...commandContext.flags },
        })
      },
    },
    {
      name: 'make:factory',
      description: 'Create a factory file.',
      usage: 'holo make:factory <name>',
      source: 'internal',
      async prepare(input) {
        return {
          args: [await ensureRequiredArg(context, input, 0, 'Factory name')],
          flags: {},
        }
      },
      async run(commandContext) {
        const runMakeFactory = await resolveGeneratorCommand('runMakeFactory')
        await runMakeFactory(context, context.projectRoot, {
          args: commandContext.args,
          flags: { ...commandContext.flags },
        })
      },
    },
    {
      name: 'migrate',
      description: 'Run registered migrations.',
      usage: 'holo migrate [--step N]',
      source: 'internal',
      async prepare(input) {
        return {
          args: [],
          flags: {
            ...(typeof parseNumberFlag(input.flags, 'step') === 'number' ? { step: parseNumberFlag(input.flags, 'step')! } : {}),
          },
        }
      },
      async run(commandContext) {
        const executeRuntime = await resolveRuntimeExecutor(runtimeExecutor)
        await executeRuntime(
          context.projectRoot,
          'migrate',
          {
            ...(typeof commandContext.flags.step === 'number' ? { step: commandContext.flags.step } : {}),
          },
          async (stdout) => {
            writeLine(context.stdout, stdout || 'No migrations were executed.')
          },
        )
      },
    },
    {
      name: 'migrate:fresh',
      description: 'Drop all tables and rerun all registered migrations.',
      usage: 'holo migrate:fresh [--seed] [--only a,b,c] [--quietly] [--force]',
      source: 'internal',
      async prepare(input) {
        return {
          args: [],
          flags: {
            seed: resolveBooleanFlag(input.flags, 'seed'),
            ...(collectMultiStringFlag(input.flags, 'only')
              ? { only: collectMultiStringFlag(input.flags, 'only')!.flatMap(entry => splitCsv(entry)) }
              : {}),
            quietly: resolveBooleanFlag(input.flags, 'quietly'),
            force: resolveBooleanFlag(input.flags, 'force'),
          },
        }
      },
      async run(commandContext) {
        const executeRuntime = await resolveRuntimeExecutor(runtimeExecutor)
        await executeRuntime(
          context.projectRoot,
          'fresh',
          {
            seed: false,
          },
          async (stdout) => {
            for (const line of stdout.split('\n').filter(Boolean)) {
              writeLine(context.stdout, line)
            }
          },
        )

        if (commandContext.flags.seed !== true) {
          return
        }

        await executeRuntime(
          context.projectRoot,
          'seed',
          {
            ...(Array.isArray(commandContext.flags.only) ? { only: commandContext.flags.only } : {}),
            quietly: commandContext.flags.quietly === true,
            force: commandContext.flags.force === true,
            environment: process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development',
          },
          async (stdout) => {
            writeLine(context.stdout, stdout || 'No seeders were executed.')
          },
        )
      },
    },
    {
      name: 'migrate:rollback',
      description: 'Rollback registered migrations.',
      usage: 'holo migrate:rollback [--step N] [--batch N]',
      source: 'internal',
      async prepare(input) {
        const step = parseNumberFlag(input.flags, 'step')
        const batch = parseNumberFlag(input.flags, 'batch')
        return {
          args: [],
          flags: {
            ...(typeof step === 'number' ? { step } : {}),
            ...(typeof batch === 'number' ? { batch } : {}),
          },
        }
      },
      async run(commandContext) {
        const executeRuntime = await resolveRuntimeExecutor(runtimeExecutor)
        await executeRuntime(
          context.projectRoot,
          'rollback',
          {
            ...(typeof commandContext.flags.step === 'number' ? { step: commandContext.flags.step } : {}),
            ...(typeof commandContext.flags.batch === 'number' ? { batch: commandContext.flags.batch } : {}),
          },
          async (stdout) => {
            writeLine(context.stdout, stdout || 'No migrations were executed.')
          },
        )
      },
    },
    {
      name: 'seed',
      description: 'Run registered seeders.',
      usage: 'holo seed [--only a,b,c] [--quietly] [--force]',
      source: 'internal',
      async prepare(input) {
        return {
          args: [],
          flags: {
            ...(collectMultiStringFlag(input.flags, 'only')
              ? { only: collectMultiStringFlag(input.flags, 'only')!.flatMap(entry => splitCsv(entry)) }
              : {}),
            quietly: resolveBooleanFlag(input.flags, 'quietly'),
            force: resolveBooleanFlag(input.flags, 'force'),
          },
        }
      },
      async run(commandContext) {
        const executeRuntime = await resolveRuntimeExecutor(runtimeExecutor)
        await executeRuntime(
          context.projectRoot,
          'seed',
          {
            ...(Array.isArray(commandContext.flags.only) ? { only: commandContext.flags.only } : {}),
            quietly: commandContext.flags.quietly === true,
            force: commandContext.flags.force === true,
            environment: process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development',
          },
          async (stdout) => {
            writeLine(context.stdout, stdout || 'No seeders were executed.')
          },
        )
      },
    },
    {
      name: 'prune',
      description: 'Prune registered prunable models.',
      usage: 'holo prune [ModelName ...]',
      source: 'internal',
      async prepare(input) {
        return {
          args: [...input.args],
          flags: {},
        }
      },
      async run(commandContext) {
        const executeRuntime = await resolveRuntimeExecutor(runtimeExecutor)
        await executeRuntime(
          context.projectRoot,
          'prune',
          { models: [...commandContext.args] },
          async (stdout) => {
            for (const line of stdout.split('\n').filter(Boolean)) {
              writeLine(context.stdout, line)
            }
          },
        )
      },
    },
  ]
}

export function createAppCommandDefinition(command: DiscoveredAppCommand): CommandDefinition {
  return {
    name: command.name,
    aliases: command.aliases,
    description: command.description,
    usage: command.usage ?? `holo ${command.name}`,
    source: 'app',
    async run(context) {
      if (!context.withRuntime) throw new Error(`Application command "${command.name}" requires a complete execution context.`)
      await (await command.load()).run({
        ...context,
        withRuntime: context.withRuntime,
      })
    },
  }
}

export function commandTokens(command: CommandDefinition): string[] {
  return [command.name, ...(command.aliases ?? [])]
}

export function findCommandConflict(
  registry: readonly CommandDefinition[],
  candidate: CommandDefinition,
): { token: string, command: CommandDefinition } | undefined {
  for (const token of commandTokens(candidate)) {
    const conflict = registry.find(command => commandTokens(command).includes(token))
    if (conflict) {
      return {
        token,
        command: conflict,
      }
    }
  }

  return undefined
}

export function findCommand(
  registry: readonly CommandDefinition[],
  name: string,
): CommandDefinition | undefined {
  return registry.find(command => command.name === name || command.aliases?.includes(name))
}

export async function runCli(argv: readonly string[], io: IoStreams): Promise<number> {
  try {
    const requestedCommandName = argv[0]
    const usesCurrentDirectoryAsProjectRoot = requestedCommandName === 'new'
      || requestedCommandName === 'agents:install'
      || requestedCommandName === 'agent:install'
      || requestedCommandName === 'ai:install'
    const projectRoot = usesCurrentDirectoryAsProjectRoot
      ? io.cwd
      : await (await loadProjectRuntimeModule()).findProjectRoot(io.cwd)
    let cachedProject: LoadedProjectConfig | undefined
    const loadProject = async () => {
      cachedProject ??= await (await loadProjectConfigModule()).loadProjectConfig(projectRoot)
      return cachedProject
    }

    const placeholderRegistry: CommandDefinition[] = []
    const internalContext: InternalCommandContext = {
      ...io,
      projectRoot,
      registry: placeholderRegistry,
      loadProject,
    }
    const internalCommands = createInternalCommands(internalContext)
    const registry = [...internalCommands]
    const requestedInternalCommand = requestedCommandName
      ? findCommand(registry, requestedCommandName)
      : undefined
    const canSkipAppDiscovery = requestedCommandName === 'config:cache'
      || requestedCommandName === 'config:clear'
      || requestedCommandName === 'key:generate'
      || requestedCommandName === 'new'
      || requestedCommandName === 'install'
      || requestedCommandName === 'agents:install'
      || requestedCommandName === 'agent:install'
      || requestedCommandName === 'ai:install'
      || requestedCommandName === 'auth:notifications:publish'
      || requestedCommandName === 'prepare'
      || requestedCommandName === 'dev'
      || requestedCommandName === 'build'
      || requestedCommandName === 'cache:table'
      || requestedCommandName === 'cache:clear'
      || requestedCommandName === 'cache:forget'
      || requestedCommandName === 'media:table'
      || requestedCommandName === 'broadcast:work'
      || requestedCommandName === 'queue:table'
      || requestedCommandName === 'queue:failed-table'
      || requestedCommandName === 'queue:work'
      || requestedCommandName === 'queue:listen'
      || requestedCommandName === 'queue:failed'
      || requestedCommandName === 'queue:retry'
      || requestedCommandName === 'queue:forget'
      || requestedCommandName === 'queue:flush'
      || requestedCommandName === 'queue:restart'
      || requestedCommandName === 'queue:clear'
      || requestedCommandName === 'rate-limit:clear'
      || requestedCommandName === 'plugin:add'
      || requestedCommandName === 'plugins:add'
      || requestedCommandName === 'plugin:list'
      || requestedCommandName === 'plugins:list'
      || requestedCommandName === 'plugin:remove'
      || requestedCommandName === 'plugins:remove'
      || requestedCommandName === 'plugin:info'
      || requestedCommandName === 'plugins:info'
      || requestedCommandName === 'plugin:doctor'
      || requestedCommandName === 'plugins:doctor'
      || (typeof requestedInternalCommand !== 'undefined' && requestedInternalCommand.name !== 'list')

    if (!canSkipAppDiscovery) {
      const initialProject = await loadProject()
      const pluginCommands = await (await loadProjectPluginsModule()).loadProjectPluginCommands(projectRoot)
      const appCommands = [
        ...pluginCommands,
        ...(await (await loadProjectDiscoveryModule()).discoverAppCommands(projectRoot, initialProject.config)),
      ]
        .map(entry => createAppCommandDefinition(entry))

      for (const appCommand of appCommands) {
        const duplicate = findCommandConflict(registry, appCommand)
        if (duplicate) {
          throw new Error(
            `App command "${appCommand.name}" conflicts with ${duplicate.command.source} command `
            + `"${duplicate.command.name}" via "${duplicate.token}".`,
          )
        }

        registry.push(appCommand)
      }
    }

    placeholderRegistry.push(...registry)

    if (!requestedCommandName || requestedCommandName === 'help' || requestedCommandName === '--help' || requestedCommandName === '-h') {
      printCommandList(io, placeholderRegistry)
      return 0
    }

    const command = findCommand(placeholderRegistry, requestedCommandName)
    if (!command) {
      writeLine(io.stderr, `Unknown command "${requestedCommandName}".`)
      printCommandList(io, placeholderRegistry)
      return 1
    }

    const parsed = parseTokens(argv.slice(1))
    if (parsed.flags.help === true || parsed.flags.h === true) {
      printCommandHelp(io, command)
      return 0
    }

    const prepared = command.prepare
      ? await command.prepare(parsed, internalContext)
      : {
          args: parsed.args,
          flags: parsed.flags as Record<string, CommandFlagValue>,
        }

    const commandContext = createCommandContext(io, projectRoot, loadProject, prepared)
    await command.run(commandContext)
    return 0
  } catch (error) {
    writeLine(io.stderr, error instanceof Error ? error.message : String(error))
    return 1
  }
}
