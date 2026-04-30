import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  normalizeHoloProjectConfig,
  renderGeneratedSchemaPlaceholder,
} from '@holo-js/db'
import {
  ESBUILD_PACKAGE_VERSION,
  HOLO_PACKAGE_VERSION,
  SCAFFOLD_FRAMEWORK_ADAPTER_VERSIONS,
  SCAFFOLD_FRAMEWORK_RUNTIME_VERSIONS,
  SCAFFOLD_FRAMEWORK_VERSIONS,
  SCAFFOLD_PACKAGE_MANAGER_VERSIONS,
} from '../../metadata'
import { resolveGeneratedSchemaPath } from '../config'
import {
  DB_DRIVER_PACKAGE_NAMES,
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
  normalizeScaffoldEnvSegments,
  renderAuthUserModel,
  renderAuthorizationAbilitiesReadme,
  renderAuthorizationPoliciesReadme,
  renderEnvFileContents,
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
  renderFrameworkFiles,
  renderFrameworkRunner,
  renderNextHoloHelper,
  renderSvelteHoloHelper,
} from './framework-renderers'

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
    typescript: '^5.8.0',
    '@types/node': '^22.0.0',
  }

  if (options.framework === 'nuxt') {
    dependencies.nuxt = SCAFFOLD_FRAMEWORK_VERSIONS.nuxt
    dependencies.vue = '^3.5.13'
    dependencies['vue-router'] = '^4.1.6'
    dependencies['@holo-js/adapter-nuxt'] = SCAFFOLD_FRAMEWORK_ADAPTER_VERSIONS.nuxt
    devDependencies.vite = '^5.4.14'
    devDependencies['vue-tsc'] = '^2.2.0'
  }

  if (options.framework === 'next') {
    dependencies.next = SCAFFOLD_FRAMEWORK_VERSIONS.next
    dependencies.react = '^19.0.0'
    dependencies['react-dom'] = '^19.0.0'
    dependencies['@holo-js/adapter-next'] = SCAFFOLD_FRAMEWORK_ADAPTER_VERSIONS.next
    devDependencies['@types/react'] = '^19.0.0'
    devDependencies['@types/react-dom'] = '^19.0.0'
  }

  if (options.framework === 'sveltekit') {
    dependencies['@holo-js/adapter-sveltekit'] = SCAFFOLD_FRAMEWORK_ADAPTER_VERSIONS.sveltekit
    dependencies['@sveltejs/adapter-node'] = '^5.0.0'
    dependencies['@sveltejs/kit'] = SCAFFOLD_FRAMEWORK_VERSIONS.sveltekit
    dependencies['@sveltejs/vite-plugin-svelte'] = '^4.0.0'
    dependencies.svelte = '^5.0.0'
    dependencies.vite = '^5.0.0'
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

  if (optionalPackages.includes('broadcast')) {
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
      prepare: 'holo prepare',
      dev: 'holo dev',
      build: 'holo build',
      lint: options.framework === 'nuxt'
        ? 'npx eslint app.vue config server tests --fix --no-warn-ignored --no-error-on-unmatched-pattern'
        : options.framework === 'next'
          ? 'npx eslint app config server tests --fix --no-warn-ignored --no-error-on-unmatched-pattern'
          : 'npx eslint src config server tests --fix --no-warn-ignored --no-error-on-unmatched-pattern',
      typecheck: options.framework === 'nuxt'
        ? 'npx nuxi typecheck'
        : options.framework === 'next'
          ? 'npx tsc -p tsconfig.json --noEmit'
          : 'npx svelte-kit sync && npx svelte-check --tsconfig ./tsconfig.json',
      ['config:cache']: 'holo config:cache',
      ['config:clear']: 'holo config:clear',
      ['holo:dev']: 'node ./.holo-js/framework/run.mjs dev',
      ['holo:build']: 'node ./.holo-js/framework/run.mjs build',
    },
    dependencies,
    devDependencies,
  }, null, 2)}\n`
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
  const securityEnabled = optionalPackages.includes('security')
  const cacheEnabled = optionalPackages.includes('cache')
  const broadcastEnvFiles = broadcastEnabled ? renderBroadcastEnvFiles() : undefined
  const baseEnv = normalizeScaffoldEnvSegments(env)
  const baseExample = normalizeScaffoldEnvSegments(example)
  const scaffoldEnvSegments = broadcastEnvFiles
    ? [...baseEnv, ...broadcastEnvFiles.env]
    : baseEnv
  const scaffoldEnvExampleSegments = broadcastEnvFiles
    ? [...baseExample, ...broadcastEnvFiles.example]
    : baseExample
  const scaffoldEnv = renderEnvFileContents(scaffoldEnvSegments)
  const scaffoldEnvExample = renderEnvFileContents(scaffoldEnvExampleSegments)

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
  await writeFile(resolve(projectRoot, 'config/app.ts'), renderScaffoldAppConfig(options.projectName), 'utf8')
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
    await ensureRateLimitStorageIgnore(projectRoot)
  }
  if (cacheEnabled) {
    await writeFile(resolve(projectRoot, 'config/cache.ts'), renderCacheConfig('file', 'main'), 'utf8')
  }
  if (authEnabled) {
    await writeFile(resolve(projectRoot, 'config/auth.ts'), renderAuthConfig(), 'utf8')
    await writeFile(resolve(projectRoot, 'config/session.ts'), renderSessionConfig('main'), 'utf8')
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
  await writeFile(generatedSchemaPath, renderGeneratedSchemaPlaceholder(), 'utf8')

  for (const file of renderFrameworkFiles(options)) {
    await writeTextFile(resolve(projectRoot, file.path), file.contents)
  }

  if (options.databaseDriver === 'sqlite') {
    await writeFile(resolve(projectRoot, 'storage/database.sqlite'), '', 'utf8')
  }
}
