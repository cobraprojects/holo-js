import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  normalizeHoloProjectConfig,
  renderGeneratedSchemaPlaceholder,
} from '@holo-js/db'
import {
  ESBUILD_PACKAGE_VERSION,
  HOLO_PACKAGE_VERSION,
  SCAFFOLD_BASE_DEV_DEPENDENCY_VERSIONS,
  SCAFFOLD_FRAMEWORK_ADAPTER_VERSIONS,
  SCAFFOLD_FRAMEWORK_RUNTIME_VERSIONS,
  SCAFFOLD_FRAMEWORK_VERSIONS,
  SCAFFOLD_NEXT_REACT_VERSIONS,
  SCAFFOLD_NUXT_DEPENDENCY_VERSIONS,
  SCAFFOLD_PACKAGE_MANAGER_VERSIONS,
  SCAFFOLD_SVELTEKIT_DEPENDENCY_VERSIONS,
} from '../../metadata'
import { resolveGeneratedSchemaPath } from '../config'
import { renderGeneratedModelTypes } from '../registry'
import {
  DB_DRIVER_PACKAGE_NAMES,
  GENERATED_MODEL_TYPES_PATH,
  normalizeScaffoldOptionalPackages,
  sanitizePackageName,
  type ProjectScaffoldOptions,
  type SupportedScaffoldPackageManager,
} from '../shared'
import { writeTextFile } from '../runtime'
import {
  ensureRateLimitStorageIgnore,
  renderAuthConfig,
  renderBroadcastConfig,
  renderBroadcastEnvFiles,
  renderCacheConfig,
  renderCorsConfig,
  renderMailConfig,
  renderNotificationsConfig,
  renderQueueConfig,
  renderRedisConfig,
  renderSecurityConfig,
  renderSessionConfig,
  renderStorageConfig,
  syncBroadcastAuthSupportAfterAuthInstall,
} from './config-renderers'
import {
  createAuthMigrationFiles,
  createNotificationsMigrationFiles,
  renderAuthEmailVerificationNotification,
  renderAuthPasswordResetNotification,
  renderAuthUserModel,
  renderAuthorizationAbilitiesReadme,
  renderAuthorizationPoliciesReadme,
  renderScaffoldAppConfig,
  renderScaffoldDatabaseConfig,
  renderScaffoldEnvFiles,
  resolveAuthUserModelSchemaImportPath,
} from './project-renderers'
import {
  renderScaffoldGitignore,
  renderScaffoldTsconfig,
  renderVSCodeSettings,
} from './workspace-renderers'
import {
  renderFrameworkFiles,
  renderFrameworkRunner,
} from './framework-renderers'

export {
  renderAuthRouteFiles,
  renderFrameworkFiles,
  renderFrameworkRunner,
  renderNextManagedHostedAuthRouteFiles,
  renderNextHoloHelper,
  renderSvelteHoloHelper,
} from './framework-renderers'
export { renderAuthProviderRouteFiles } from './framework-renderers'

export function resolvePackageManagerVersion(value: SupportedScaffoldPackageManager): string {
  return SCAFFOLD_PACKAGE_MANAGER_VERSIONS[value]
}

export function renderScaffoldPackageJson(options: ProjectScaffoldOptions): string {
  const packageName = sanitizePackageName(options.projectName) || 'holo-app'
  const optionalPackages = normalizeScaffoldOptionalPackages(options.optionalPackages)
  const dependencies: Record<string, string> = {
    '@holo-js/cli': `^${HOLO_PACKAGE_VERSION}`,
    '@holo-js/config': `^${HOLO_PACKAGE_VERSION}`,
    '@holo-js/core': `^${HOLO_PACKAGE_VERSION}`,
    '@holo-js/db': `^${HOLO_PACKAGE_VERSION}`,
    [DB_DRIVER_PACKAGE_NAMES[options.databaseDriver]]: `^${HOLO_PACKAGE_VERSION}`,
    esbuild: ESBUILD_PACKAGE_VERSION,
  }
  const devDependencies: Record<string, string> = {
    typescript: SCAFFOLD_BASE_DEV_DEPENDENCY_VERSIONS.typescript,
    '@types/node': SCAFFOLD_BASE_DEV_DEPENDENCY_VERSIONS['@types/node'],
    eslint: SCAFFOLD_BASE_DEV_DEPENDENCY_VERSIONS.eslint,
  }

  if (options.framework === 'nuxt') {
    dependencies.nuxt = SCAFFOLD_FRAMEWORK_VERSIONS.nuxt
    dependencies.vue = SCAFFOLD_NUXT_DEPENDENCY_VERSIONS.vue
    dependencies['vue-router'] = SCAFFOLD_NUXT_DEPENDENCY_VERSIONS['vue-router']
    dependencies['@holo-js/adapter-nuxt'] = SCAFFOLD_FRAMEWORK_ADAPTER_VERSIONS.nuxt
    devDependencies['vue-tsc'] = SCAFFOLD_NUXT_DEPENDENCY_VERSIONS['vue-tsc']
  }

  if (options.framework === 'next') {
    dependencies.next = SCAFFOLD_FRAMEWORK_VERSIONS.next
    dependencies.react = SCAFFOLD_NEXT_REACT_VERSIONS.react
    dependencies['react-dom'] = SCAFFOLD_NEXT_REACT_VERSIONS['react-dom']
    dependencies['@holo-js/adapter-next'] = SCAFFOLD_FRAMEWORK_ADAPTER_VERSIONS.next
    devDependencies['@types/react'] = SCAFFOLD_NEXT_REACT_VERSIONS['@types/react']
    devDependencies['@types/react-dom'] = SCAFFOLD_NEXT_REACT_VERSIONS['@types/react-dom']
  }

  if (options.framework === 'sveltekit') {
    dependencies['@holo-js/adapter-sveltekit'] = SCAFFOLD_FRAMEWORK_ADAPTER_VERSIONS.sveltekit
    dependencies['@sveltejs/adapter-node'] = SCAFFOLD_SVELTEKIT_DEPENDENCY_VERSIONS['@sveltejs/adapter-node']
    dependencies['@sveltejs/kit'] = SCAFFOLD_FRAMEWORK_VERSIONS.sveltekit
    dependencies['@sveltejs/vite-plugin-svelte'] = SCAFFOLD_SVELTEKIT_DEPENDENCY_VERSIONS['@sveltejs/vite-plugin-svelte']
    dependencies.svelte = SCAFFOLD_SVELTEKIT_DEPENDENCY_VERSIONS.svelte
    dependencies.vite = SCAFFOLD_SVELTEKIT_DEPENDENCY_VERSIONS.vite
    devDependencies['svelte-check'] = SCAFFOLD_SVELTEKIT_DEPENDENCY_VERSIONS['svelte-check']
  }

  if (optionalPackages.includes('storage')) {
    dependencies['@holo-js/storage'] = SCAFFOLD_FRAMEWORK_RUNTIME_VERSIONS[options.framework]['@holo-js/storage']
  }

  if (optionalPackages.includes('events')) {
    dependencies['@holo-js/events'] = `^${HOLO_PACKAGE_VERSION}`
    dependencies['@holo-js/queue'] = `^${HOLO_PACKAGE_VERSION}`
  }

  if (optionalPackages.includes('queue')) {
    dependencies['@holo-js/queue'] = `^${HOLO_PACKAGE_VERSION}`
  }

  if (optionalPackages.includes('validation')) {
    dependencies['@holo-js/validation'] = `^${HOLO_PACKAGE_VERSION}`
  }

  if (optionalPackages.includes('forms')) {
    dependencies['@holo-js/forms'] = `^${HOLO_PACKAGE_VERSION}`
  }

  if (optionalPackages.includes('auth')) {
    dependencies['@holo-js/auth'] = `^${HOLO_PACKAGE_VERSION}`
    dependencies['@holo-js/session'] = `^${HOLO_PACKAGE_VERSION}`
    dependencies['@holo-js/security'] = `^${HOLO_PACKAGE_VERSION}`
  }

  if (optionalPackages.includes('authorization')) {
    dependencies['@holo-js/authorization'] = `^${HOLO_PACKAGE_VERSION}`
  }

  if (optionalPackages.includes('notifications')) {
    dependencies['@holo-js/notifications'] = `^${HOLO_PACKAGE_VERSION}`
  }

  if (optionalPackages.includes('mail')) {
    dependencies['@holo-js/mail'] = `^${HOLO_PACKAGE_VERSION}`
  }

  if (optionalPackages.includes('broadcast') || optionalPackages.includes('realtime')) {
    dependencies['@holo-js/broadcast'] = `^${HOLO_PACKAGE_VERSION}`
    dependencies['@holo-js/flux'] = `^${HOLO_PACKAGE_VERSION}`
    if (options.framework === 'next') {
      dependencies['@holo-js/flux-react'] = `^${HOLO_PACKAGE_VERSION}`
    } else if (options.framework === 'nuxt') {
      dependencies['@holo-js/flux-vue'] = `^${HOLO_PACKAGE_VERSION}`
    } else if (options.framework === 'sveltekit') {
      dependencies['@holo-js/flux-svelte'] = `^${HOLO_PACKAGE_VERSION}`
    }
  }

  if (optionalPackages.includes('realtime')) {
    dependencies['@holo-js/realtime'] = `^${HOLO_PACKAGE_VERSION}`
  }

  if (optionalPackages.includes('security')) {
    dependencies['@holo-js/security'] = `^${HOLO_PACKAGE_VERSION}`
  }

  if (optionalPackages.includes('cache')) {
    dependencies['@holo-js/cache'] = `^${HOLO_PACKAGE_VERSION}`
  }

  return `${JSON.stringify({
    name: packageName,
    private: true,
    type: 'module',
    packageManager: resolvePackageManagerVersion(options.packageManager),
    scripts: {
      ...(options.framework === 'nuxt'
        ? { postinstall: 'nuxt prepare' }
        : {}),
      prepare: 'holo key:generate && holo prepare',
      dev: 'holo dev',
      build: 'holo build',
      lint: options.framework === 'nuxt'
        ? 'eslint app config server shared tests *.d.ts --fix --no-warn-ignored --no-error-on-unmatched-pattern'
        : options.framework === 'next'
          ? 'eslint app config server tests --fix --no-warn-ignored --no-error-on-unmatched-pattern'
          : 'eslint src config server tests --fix --no-warn-ignored --no-error-on-unmatched-pattern',
      typecheck: options.framework === 'nuxt'
        ? 'nuxt typecheck'
        : options.framework === 'next'
          ? 'tsc -p tsconfig.json --noEmit'
          : 'svelte-kit sync && svelte-check --tsconfig ./tsconfig.json',
      ['config:cache']: 'holo config:cache',
      ['config:clear']: 'holo config:clear',
      ['holo:dev']: 'node ./.holo-js/framework/run.mjs dev',
      ['holo:build']: 'node ./.holo-js/framework/run.mjs build',
    },
    dependencies,
    devDependencies,
  }, null, 2)}\n`
}

function appendScaffoldEnvGroup(contents: string, group: readonly string[] | undefined): string {
  const normalizedGroup = group
    ?.map(line => line.trim())
    .filter(line => line.length > 0) ?? []

  if (normalizedGroup.length === 0) {
    return contents
  }

  const normalizedContents = contents.trimEnd()
  if (normalizedContents.length === 0) {
    return `${normalizedGroup.join('\n')}\n`
  }

  return `${normalizedContents}\n\n${normalizedGroup.join('\n')}\n`
}

export async function scaffoldProject(
  projectRoot: string,
  options: ProjectScaffoldOptions,
): Promise<void> {
  const existingEntries = await readdir(projectRoot).catch(() => [] as string[])
  if (existingEntries.length > 0) {
    throw new Error(`Refusing to scaffold into a non-empty directory: ${projectRoot}`)
  }

  const { env, example } = renderScaffoldEnvFiles(options)
  const config = normalizeHoloProjectConfig()
  const generatedSchemaPath = resolveGeneratedSchemaPath(projectRoot, config)
  const optionalPackages = normalizeScaffoldOptionalPackages(options.optionalPackages)
  const storageEnabled = optionalPackages.includes('storage')
  const queueEnabled = optionalPackages.includes('queue')
  const eventsEnabled = optionalPackages.includes('events')
  const authEnabled = optionalPackages.includes('auth')
  const authorizationEnabled = optionalPackages.includes('authorization')
  const notificationsEnabled = optionalPackages.includes('notifications')
  const mailEnabled = optionalPackages.includes('mail')
  const broadcastEnabled = optionalPackages.includes('broadcast')
  const realtimeEnabled = optionalPackages.includes('realtime')
  const securityEnabled = optionalPackages.includes('security')
  const cacheEnabled = optionalPackages.includes('cache')
  const broadcastEnvFiles = broadcastEnabled ? renderBroadcastEnvFiles() : undefined
  const scaffoldEnv = appendScaffoldEnvGroup(env, broadcastEnvFiles?.env)
  const scaffoldEnvExample = appendScaffoldEnvGroup(example, broadcastEnvFiles?.example)

  await mkdir(projectRoot, { recursive: true })
  await mkdir(resolve(projectRoot, 'config'), { recursive: true })
  await mkdir(resolve(projectRoot, '.holo-js', 'framework'), { recursive: true })
  await mkdir(resolve(projectRoot, config.paths.models), { recursive: true })
  await mkdir(resolve(projectRoot, config.paths.commands), { recursive: true })
  if (queueEnabled) {
    await mkdir(resolve(projectRoot, config.paths.jobs), { recursive: true })
  }
  if (eventsEnabled) {
    await mkdir(resolve(projectRoot, config.paths.events), { recursive: true })
    await mkdir(resolve(projectRoot, config.paths.listeners), { recursive: true })
  }
  if (authorizationEnabled) {
    await mkdir(resolve(projectRoot, 'server/policies'), { recursive: true })
    await mkdir(resolve(projectRoot, 'server/abilities'), { recursive: true })
  }
  if (mailEnabled) {
    await mkdir(resolve(projectRoot, 'server/mail'), { recursive: true })
  }
  if (broadcastEnabled) {
    await mkdir(resolve(projectRoot, 'server/broadcast'), { recursive: true })
    await mkdir(resolve(projectRoot, 'server/channels'), { recursive: true })
  }
  if (realtimeEnabled) {
    await mkdir(resolve(projectRoot, 'server/realtime'), { recursive: true })
  }
  await mkdir(resolve(projectRoot, 'server/db/factories'), { recursive: true })
  await mkdir(resolve(projectRoot, 'server/db/migrations'), { recursive: true })
  await mkdir(resolve(projectRoot, 'server/db/seeders'), { recursive: true })
  await mkdir(resolve(projectRoot, 'server/db/schema'), { recursive: true })
  await mkdir(resolve(projectRoot, config.paths.observers), { recursive: true })
  await mkdir(resolve(projectRoot, 'storage'), { recursive: true })
  if (storageEnabled) {
    await mkdir(resolve(projectRoot, 'storage/app/public'), { recursive: true })
  }

  await writeFile(resolve(projectRoot, 'package.json'), renderScaffoldPackageJson(options), 'utf8')
  await writeFile(resolve(projectRoot, '.gitignore'), renderScaffoldGitignore(), 'utf8')
  await writeFile(resolve(projectRoot, '.env'), scaffoldEnv, 'utf8')
  await writeFile(resolve(projectRoot, '.env.example'), scaffoldEnvExample, 'utf8')
  await writeFile(resolve(projectRoot, 'config/app.ts'), renderScaffoldAppConfig(options.projectName, options.framework), 'utf8')
  await writeFile(resolve(projectRoot, 'config/database.ts'), renderScaffoldDatabaseConfig(options), 'utf8')
  await writeFile(resolve(projectRoot, 'config/redis.ts'), renderRedisConfig(), 'utf8')
  if (queueEnabled) {
    await writeFile(resolve(projectRoot, 'config/queue.ts'), renderQueueConfig({
      driver: 'sync',
      defaultDatabaseConnection: 'main',
    }), 'utf8')
  }
  if (notificationsEnabled) {
    await writeFile(resolve(projectRoot, 'config/notifications.ts'), renderNotificationsConfig(), 'utf8')
    for (const migrationFile of createNotificationsMigrationFiles()) {
      await writeFile(resolve(projectRoot, config.paths.migrations, migrationFile.path), migrationFile.contents, 'utf8')
    }
  }
  if (mailEnabled) {
    await writeFile(resolve(projectRoot, 'config/mail.ts'), renderMailConfig(), 'utf8')
  }
  if (broadcastEnabled) {
    await writeFile(resolve(projectRoot, 'config/broadcast.ts'), renderBroadcastConfig('esm', false, true), 'utf8')
  }
  if (securityEnabled) {
    await writeFile(resolve(projectRoot, 'config/security.ts'), renderSecurityConfig(), 'utf8')
    await writeFile(resolve(projectRoot, 'config/cors.ts'), renderCorsConfig(), 'utf8')
    await ensureRateLimitStorageIgnore(projectRoot)
  }
  if (cacheEnabled) {
    await writeFile(resolve(projectRoot, 'config/cache.ts'), renderCacheConfig('file', 'main'), 'utf8')
  }
  if (authEnabled) {
    await writeFile(resolve(projectRoot, 'config/auth.ts'), renderAuthConfig(), 'utf8')
    await writeFile(resolve(projectRoot, 'config/session.ts'), renderSessionConfig('main'), 'utf8')
    if (!securityEnabled) {
      await writeFile(resolve(projectRoot, 'config/security.ts'), renderSecurityConfig(), 'utf8')
      await writeFile(resolve(projectRoot, 'config/cors.ts'), renderCorsConfig(), 'utf8')
      await ensureRateLimitStorageIgnore(projectRoot)
    }
    const userModelPath = resolve(projectRoot, config.paths.models, 'User.ts')
    await writeFile(
      userModelPath,
      renderAuthUserModel(resolveAuthUserModelSchemaImportPath(
        userModelPath,
        generatedSchemaPath,
      )),
      'utf8',
    )

    for (const migrationFile of createAuthMigrationFiles()) {
      await writeFile(resolve(projectRoot, config.paths.migrations, migrationFile.path), migrationFile.contents, 'utf8')
    }
  }
  if (authEnabled && notificationsEnabled) {
    await mkdir(resolve(projectRoot, 'server/notifications/auth'), { recursive: true })
    await writeFile(
      resolve(projectRoot, 'server/notifications/auth/email-verification.ts'),
      renderAuthEmailVerificationNotification(),
      'utf8',
    )
    await writeFile(
      resolve(projectRoot, 'server/notifications/auth/password-reset.ts'),
      renderAuthPasswordResetNotification(),
      'utf8',
    )
  }
  if (broadcastEnabled && authEnabled) {
    await syncBroadcastAuthSupportAfterAuthInstall(projectRoot)
  }
  if (authorizationEnabled) {
    await writeFile(resolve(projectRoot, 'server/policies/README.md'), renderAuthorizationPoliciesReadme(), 'utf8')
    await writeFile(resolve(projectRoot, 'server/abilities/README.md'), renderAuthorizationAbilitiesReadme(), 'utf8')
  }
  if (storageEnabled) {
    await writeFile(resolve(projectRoot, 'config/storage.ts'), renderStorageConfig(), 'utf8')
  }
  await writeFile(resolve(projectRoot, '.holo-js/framework/run.mjs'), renderFrameworkRunner(options), 'utf8')
  await writeFile(resolve(projectRoot, '.holo-js/framework/project.json'), `${JSON.stringify(options, null, 2)}\n`, 'utf8')
  await writeFile(resolve(projectRoot, 'tsconfig.json'), renderScaffoldTsconfig(options), 'utf8')
  const vscodeSettings = renderVSCodeSettings(options)
  if (vscodeSettings) {
    await mkdir(resolve(projectRoot, '.vscode'), { recursive: true })
    await writeFile(resolve(projectRoot, '.vscode/settings.json'), vscodeSettings, 'utf8')
  }
  await mkdir(dirname(generatedSchemaPath), { recursive: true })
  await writeFile(generatedSchemaPath, renderGeneratedSchemaPlaceholder(), 'utf8')
  await writeFile(resolve(projectRoot, GENERATED_MODEL_TYPES_PATH), renderGeneratedModelTypes([]), 'utf8')

  for (const file of renderFrameworkFiles(options)) {
    await writeTextFile(resolve(projectRoot, file.path), file.contents)
  }

  if (options.databaseDriver === 'sqlite') {
    await writeFile(resolve(projectRoot, 'storage/database.sqlite'), '', 'utf8')
  }
}
