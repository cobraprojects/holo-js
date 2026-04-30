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
import type { ScaffoldedFile } from './types'
import {
  renderScaffoldGitignore,
  renderScaffoldTsconfig,
  renderVSCodeSettings,
} from './workspace-renderers'

function renderNuxtAppVue(projectName: string): string {
  return [
    '<template>',
    '  <main class="shell">',
    '    <h1>{{ appName }}</h1>',
    '    <p>Nuxt renders the UI. Holo owns the backend runtime and canonical server directories.</p>',
    '  </main>',
    '</template>',
    '',
    '<script setup lang="ts">',
    `const appName = ${JSON.stringify(projectName)}`,
    '</script>',
    '',
    '<style scoped>',
    '.shell {',
    '  min-height: 100vh;',
    '  display: grid;',
    '  place-content: center;',
    '  gap: 1rem;',
    '  padding: 3rem;',
    '  font-family: sans-serif;',
    '}',
    'h1 {',
    '  margin: 0;',
    '  font-size: clamp(2.5rem, 6vw, 4rem);',
    '}',
    'p {',
    '  margin: 0;',
    '  max-width: 40rem;',
    '  line-height: 1.6;',
    '}',
    '</style>',
    '',
  ].join('\n')
}

function renderNuxtConfig(): string {
  return [
    'export default defineNuxtConfig({',
    '  modules: [\'@holo-js/adapter-nuxt\'],',
    '  sourcemap: {',
    '    client: false,',
    '    server: false,',
    '  },',
    '  vite: {',
    '    build: {',
    '      rollupOptions: {',
    '        onwarn(warning, defaultHandler) {',
    '          if (',
    '            warning.message.includes(\'nuxt:module-preload-polyfill\')',
    '            && warning.message.includes(\'didn\\\'t generate a sourcemap\')',
    '          ) {',
    '            return',
    '          }',
    '',
    '          defaultHandler(warning)',
    '        },',
    '      },',
    '    },',
    '  },',
    '})',
    '',
  ].join('\n')
}

function renderNuxtHealthRoute(): string {
  return [
    'export default defineEventHandler(async () => {',
    '  const app = await holo.getApp()',
    '',
    '  return {',
    '    ok: true,',
    '    app: app.config.app.name,',
    '    env: app.config.app.env,',
    '    models: app.registry?.models.length ?? 0,',
    '    commands: app.registry?.commands.length ?? 0,',
    '  }',
    '})',
    '',
  ].join('\n')
}

function renderNextConfig(_storageEnabled: boolean): string {
  return [
    'import type { NextConfig } from \'next\'',
    'import { withHolo } from \'@holo-js/adapter-next/config\'',
    '',
    'const nextConfig: NextConfig = withHolo({',
    '  /* config options here */',
    '})',
    '',
    'export default nextConfig',
    '',
  ].join('\n')
}

function renderNextLayout(projectName: string): string {
  return [
    'import \'../server/db/schema.generated\'',
    '',
    'import type { ReactNode } from \'react\'',
    '',
    'export const metadata = {',
    `  title: ${JSON.stringify(projectName)},`,
    '  description: \'Holo on Next.js\',',
    '}',
    '',
    'export default function RootLayout({ children }: { children: ReactNode }) {',
    '  return (',
    '    <html lang="en">',
    '      <body>{children}</body>',
    '    </html>',
    '  )',
    '}',
    '',
  ].join('\n')
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;')
    .replaceAll('{', '&#123;')
    .replaceAll('}', '&#125;')
}

function renderNextPage(projectName: string): string {
  const escapedProjectName = escapeHtml(projectName)

  return [
    'export default function HomePage() {',
    '  return (',
    '    <main style={{ padding: \'3rem\', fontFamily: \'sans-serif\' }}>',
    `      <h1>${escapedProjectName}</h1>`,
    '      <p>Next.js handles rendering. Holo powers the backend runtime and discovered server resources.</p>',
    '    </main>',
    '  )',
    '}',
    '',
  ].join('\n')
}

function renderNextEnvDts(): string {
  return [
    '/// <reference types="next" />',
    '/// <reference types="next/image-types/global" />',
    '',
    '// Generated by Holo. Do not edit.',
    '',
  ].join('\n')
}

export function renderNextHoloHelper(): string {
  return [
    'import \'./db/schema.generated\'',
    '',
    'import { createNextHoloHelpers } from \'@holo-js/adapter-next\'',
    '',
    'export const holo = createNextHoloHelpers()',
    '',
  ].join('\n')
}

function renderNextInstrumentation(): string {
  return [
    'export async function register() {',
    '  if (process.env.NEXT_RUNTIME === \'nodejs\') {',
    '    const { holo } = await import(\'@/server/holo\')',
    '    await holo.getApp()',
    '  }',
    '}',
    '',
  ].join('\n')
}

function renderNextHealthRoute(): string {
  return [
    'import { holo } from \'@/server/holo\'',
    '',
    'export async function GET() {',
    '  const app = await holo.getApp()',
    '',
    '  return Response.json({',
    '    ok: true,',
    '    app: app.config.app.name,',
    '    env: app.config.app.env,',
    '    models: app.registry?.models.length ?? 0,',
    '    commands: app.registry?.commands.length ?? 0,',
    '  })',
    '}',
    '',
  ].join('\n')
}

function renderNextStorageRoute(): string {
  return [
    'import { holo } from \'@/server/holo\'',
    'import { createPublicStorageResponse } from \'@holo-js/storage\'',
    '',
    'export async function GET(request: Request) {',
    '  const app = await holo.getApp()',
    '  return createPublicStorageResponse(app.projectRoot, app.config.storage, request)',
    '}',
    '',
  ].join('\n')
}

function renderSvelteConfig(): string {
  return [
    'import adapter from \'@sveltejs/adapter-node\'',
    'import { vitePreprocess } from \'@sveltejs/vite-plugin-svelte\'',
    '',
    '/** @type {import(\'@sveltejs/kit\').Config} */',
    'const config = {',
    '  preprocess: vitePreprocess(),',
    '  kit: {',
    '    adapter: adapter(),',
    '    files: {',
    '      hooks: {',
    '        server: \'.holo-js/generated/hooks.server\',',
    '        universal: \'.holo-js/generated/hooks\',',
    '      },',
    '    },',
    '  },',
    '}',
    '',
    'export default config',
    '',
  ].join('\n')
}

function renderSvelteUserHooks(): string {
  return [
    'export {}',
    '',
  ].join('\n')
}

function renderSvelteServerUserHooks(): string {
  return [
    'export {}',
    '',
  ].join('\n')
}

function renderSvelteViteConfig(storageEnabled: boolean): string {
  const externals = [
    '      \'@holo-js/adapter-sveltekit\',',
    '      \'@holo-js/config\',',
    '      \'@holo-js/core\',',
    '      \'@holo-js/db\',',
    ...(storageEnabled
      ? [
          '      \'@holo-js/storage\',',
          '      \'@holo-js/storage/runtime\',',
        ]
      : []),
    '      \'better-sqlite3\',',
  ]

  return [
    'import { sveltekit } from \'@sveltejs/kit/vite\'',
    'import { defineConfig } from \'vite\'',
    '',
    'export default defineConfig({',
    '  plugins: [sveltekit()],',
    '  server: {',
    '    fs: {',
    '      allow: [\'.holo-js/generated\'],',
    '    },',
    '  },',
    '  ssr: {',
    '    external: [',
    ...externals,
    '    ],',
    '  },',
    '})',
    '',
  ].join('\n')
}

function renderSvelteAppHtml(): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '    %sveltekit.head%',
    '  </head>',
    '  <body data-sveltekit-preload-data="hover">',
    '    <div style="display: contents">%sveltekit.body%</div>',
    '  </body>',
    '</html>',
    '',
  ].join('\n')
}

function renderSveltePage(projectName: string): string {
  const escapedProjectName = escapeHtml(projectName)

  return [
    `<svelte:head><title>${escapedProjectName}</title></svelte:head>`,
    '',
    '<script lang="ts">',
    `  const projectName = ${JSON.stringify(projectName)}`,
    '</script>',
    '',
    '<main class="shell">',
    '  <h1>{projectName}</h1>',
    '  <p>SvelteKit owns rendering. Holo owns config, discovery, and backend runtime services.</p>',
    '</main>',
    '',
    '<style>',
    '  .shell {',
    '    min-height: 100vh;',
    '    display: grid;',
    '    place-content: center;',
    '    gap: 1rem;',
    '    padding: 3rem;',
    '    font-family: sans-serif;',
    '  }',
    '  h1 {',
    '    margin: 0;',
    '    font-size: clamp(2.5rem, 6vw, 4rem);',
    '  }',
    '  p {',
    '    margin: 0;',
    '    max-width: 40rem;',
    '    line-height: 1.6;',
    '  }',
    '</style>',
    '',
  ].join('\n')
}

export function renderSvelteHoloHelper(): string {
  return [
    'import \'../../../server/db/schema.generated\'',
    '',
    'import { createSvelteKitHoloHelpers } from \'@holo-js/adapter-sveltekit\'',
    '',
    'export const holo = createSvelteKitHoloHelpers()',
    '',
  ].join('\n')
}

function renderSvelteHealthRoute(): string {
  return [
    'import { json } from \'@sveltejs/kit\'',
    'import { holo } from \'$lib/server/holo\'',
    '',
    'export async function GET() {',
    '  const app = await holo.getApp()',
    '',
    '  return json({',
    '    ok: true,',
    '    app: app.config.app.name,',
    '    env: app.config.app.env,',
    '    models: app.registry?.models.length ?? 0,',
    '    commands: app.registry?.commands.length ?? 0,',
    '  })',
    '}',
    '',
  ].join('\n')
}

function renderSvelteStorageRoute(): string {
  return [
    'import { holo } from \'$lib/server/holo\'',
    'import { createPublicStorageResponse } from \'@holo-js/storage\'',
    '',
    'export async function GET({ request }: { request: Request }) {',
    '  const app = await holo.getApp()',
    '  return createPublicStorageResponse(app.projectRoot, app.config.storage, request)',
    '}',
    '',
  ].join('\n')
}

export function renderFrameworkFiles(options: ProjectScaffoldOptions): readonly ScaffoldedFile[] {
  const optionalPackages = normalizeScaffoldOptionalPackages(options.optionalPackages)
  const storageEnabled = optionalPackages.includes('storage')

  if (options.framework === 'nuxt') {
    return [
      { path: 'app.vue', contents: renderNuxtAppVue(options.projectName) },
      { path: 'nuxt.config.ts', contents: renderNuxtConfig() },
      { path: 'server/api/holo/health.get.ts', contents: renderNuxtHealthRoute() },
    ]
  }

  if (options.framework === 'next') {
    return [
      { path: 'next.config.ts', contents: renderNextConfig(storageEnabled) },
      { path: 'next-env.d.ts', contents: renderNextEnvDts() },
      { path: 'app/layout.tsx', contents: renderNextLayout(options.projectName) },
      { path: 'app/page.tsx', contents: renderNextPage(options.projectName) },
      { path: 'app/api/holo/health/route.ts', contents: renderNextHealthRoute() },
      ...(storageEnabled
        ? [{ path: 'app/storage/[[...path]]/route.ts', contents: renderNextStorageRoute() }]
        : []),
      { path: 'server/holo.ts', contents: renderNextHoloHelper() },
      { path: 'instrumentation.ts', contents: renderNextInstrumentation() },
    ]
  }

  return [
    { path: 'svelte.config.js', contents: renderSvelteConfig() },
    { path: 'vite.config.ts', contents: renderSvelteViteConfig(storageEnabled) },
    { path: 'src/hooks.ts', contents: renderSvelteUserHooks() },
    { path: 'src/hooks.server.ts', contents: renderSvelteServerUserHooks() },
    { path: 'src/app.html', contents: renderSvelteAppHtml() },
    { path: 'src/routes/+page.svelte', contents: renderSveltePage(options.projectName) },
    { path: 'src/routes/api/holo/+server.ts', contents: renderSvelteHealthRoute() },
    ...(storageEnabled
      ? [{ path: 'src/routes/storage/[...path]/+server.ts', contents: renderSvelteStorageRoute() }]
      : []),
    { path: 'src/lib/server/holo.ts', contents: renderSvelteHoloHelper() },
  ]
}

export function renderFrameworkRunner(options: Pick<ProjectScaffoldOptions, 'framework'>): string {
  const commandName = options.framework === 'nuxt'
    ? 'nuxi'
    : options.framework === 'next'
      ? 'next'
      : 'vite'
  return [
    'import { existsSync, readFileSync, readlinkSync } from \'node:fs\'',
    'import { dirname, resolve } from \'node:path\'',
    'import { fileURLToPath } from \'node:url\'',
    'import { execFileSync, spawn } from \'node:child_process\'',
    '',
    'const mode = process.argv[2]',
    'const manifestPath = fileURLToPath(new URL(\'./project.json\', import.meta.url))',
    'const projectRoot = resolve(dirname(manifestPath), \'../..\')',
    'const manifest = JSON.parse(readFileSync(manifestPath, \'utf8\'))',
    'const framework = String(manifest.framework ?? \'\')',
    `const commandName = ${JSON.stringify(commandName)}`,
    'const commandArgs = mode === \'dev\'',
    '  ? [\'dev\']',
    '  : mode === \'build\'',
    '    ? framework === \'sveltekit\' ? [\'build\', \'--logLevel\', \'error\'] : [\'build\']',
    '    : undefined',
    '',
    'if (!commandArgs) {',
    '  console.error(`[holo] Unknown framework runner mode: ${String(mode)}`)',
    '  process.exit(1)',
    '}',
    '',
    'const binaryPath = resolve(',
    '  projectRoot,',
    '  \'node_modules\',',
    '  \'.bin\',',
    '  process.platform === \'win32\' ? `${commandName}.cmd` : commandName,',
    ')',
    '',
    'const suppressedOutput = framework === \'sveltekit\'',
    '  ? new Set([',
    '      \'"try_get_request_store" is imported from external module "@sveltejs/kit/internal/server" but never used in ".svelte-kit/adapter-node/index.js".\',',
    '    ])',
    '  : new Set()',
    '',
    'function pipeOutput(stream, target, onLine) {',
    '  if (!stream) {',
    '    return',
    '  }',
    '',
    '  let buffered = \'\'',
    '  stream.on(\'data\', (chunk) => {',
    '    buffered += chunk.toString()',
    '    const lines = buffered.split(/\\r?\\n/)',
    '    buffered = lines.pop() ?? \'\'',
    '    for (const line of lines) {',
    '      onLine?.(line)',
    '      if (!suppressedOutput.has(line)) {',
    '        target.write(`${line}\\n`)',
    '      }',
    '    }',
    '  })',
    '',
    '  stream.on(\'end\', () => {',
    '    if (buffered.length > 0) {',
    '      onLine?.(buffered)',
    '    }',
    '    if (buffered.length > 0 && !suppressedOutput.has(buffered)) {',
    '      target.write(buffered)',
    '    }',
    '  })',
    '}',
    '',
    'function extractNextConflictInfo(lines) {',
    '  if (framework !== \'next\' || mode !== \'dev\') {',
    '    return undefined',
    '  }',
    '',
    '  if (!lines.some(line => line.includes(\'Another next dev server is already running.\'))) {',
    '    return undefined',
    '  }',
    '',
    '  let pid',
    '  let dir',
    '',
    '  for (const line of lines) {',
    '    const match = line.match(/^- PID:\\s+(\\d+)\\s*$/)',
    '    if (match) {',
    '      pid = Number.parseInt(match[1], 10)',
    '      continue',
    '    }',
    '',
    '    const dirMatch = line.match(/^- Dir:\\s+(.+?)\\s*$/)',
    '    if (dirMatch) {',
    '      dir = dirMatch[1]',
    '    }',
    '  }',
    '',
    '  return typeof pid === \'number\' ? { pid, dir } : undefined',
    '}',
    '',
    'async function waitForProcessExit(pid, timeoutMs = 5000) {',
    '  const deadline = Date.now() + timeoutMs',
    '  while (Date.now() < deadline) {',
    '    try {',
    '      process.kill(pid, 0)',
    '    } catch (error) {',
    '      if (error && typeof error === \'object\' && \'code\' in error && error.code === \'ESRCH\') {',
    '        return true',
    '      }',
    '      throw error',
    '    }',
    '',
    '    await new Promise(resolve => setTimeout(resolve, 100))',
    '  }',
    '',
    '  return false',
    '}',
    '',
    'function inspectProcess(pid) {',
    '  try {',
    '    if (process.platform === \'linux\' && existsSync(`/proc/${pid}`)) {',
    '      return {',
    '        cwd: readlinkSync(`/proc/${pid}/cwd`),',
    '        args: readFileSync(`/proc/${pid}/cmdline`, \'utf8\').replaceAll(\'\\u0000\', \' \').trim(),',
    '      }',
    '    }',
    '  } catch {}',
    '',
    '  try {',
    '    return {',
    '      args: execFileSync(\'ps\', [\'-p\', String(pid), \'-o\', \'args=\'], {',
    '        encoding: \'utf8\',',
    '      }).trim(),',
    '    }',
    '  } catch {',
    '    return undefined',
    '  }',
    '}',
    '',
    'function isOwnedNextDevServer(pid, reportedDir) {',
    '  const expectedDir = typeof reportedDir === \'string\' ? resolve(reportedDir) : undefined',
    '  if (expectedDir && expectedDir !== projectRoot) {',
    '    return false',
    '  }',
    '',
    '  const details = inspectProcess(pid)',
    '  if (!details) {',
    '    return expectedDir === projectRoot',
    '  }',
    '',
    '  const argsMatch = details.args.includes(\'next\') && details.args.includes(\'dev\')',
    '  const cwdMatches = typeof details.cwd === \'string\' && resolve(details.cwd) === projectRoot',
    '  const argsReferenceProject = details.args.includes(projectRoot)',
    '',
    '  return argsMatch && (cwdMatches || argsReferenceProject || expectedDir === projectRoot)',
    '}',
    '',
    'async function stopStaleNextDevServer(pid, reportedDir) {',
    '  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {',
    '    return false',
    '  }',
    '',
    '  if (!isOwnedNextDevServer(pid, reportedDir)) {',
    '    return false',
    '  }',
    '',
    '  try {',
    '    process.kill(pid, \'SIGTERM\')',
    '  } catch (error) {',
    '    if (error && typeof error === \'object\' && \'code\' in error && error.code === \'ESRCH\') {',
    '      return true',
    '    }',
    '    return false',
    '  }',
    '',
    '  return waitForProcessExit(pid)',
    '}',
    '',
    'if (!existsSync(binaryPath)) {',
    '  console.error(`[holo] Missing framework binary "${commandName}" for "${framework}". Run your package manager install first.`)',
    '  process.exit(1)',
    '}',
    '',
    'let child = null',
    'let forwardedSignal = null',
    '',
    'function detachSignalForwarders() {',
    '  process.removeListener(\'SIGINT\', onSigint)',
    '  process.removeListener(\'SIGTERM\', onSigterm)',
    '}',
    '',
    'function forwardSignal(signal) {',
    '  if (forwardedSignal || !child || child.exitCode !== null) {',
    '    return',
    '  }',
    '',
    '  forwardedSignal = signal',
    '  child.kill(signal)',
    '}',
    '',
    'function onSigint() {',
    '  detachSignalForwarders()',
    '  forwardSignal(\'SIGINT\')',
    '}',
    '',
    'function onSigterm() {',
    '  detachSignalForwarders()',
    '  forwardSignal(\'SIGTERM\')',
    '}',
    '',
    'process.on(\'SIGINT\', onSigint)',
    'process.on(\'SIGTERM\', onSigterm)',
    '',
    'async function run() {',
    '  let restartedAfterConflict = false',
    '  const maxStderrLines = 200',
    '',
    '  while (true) {',
    '    const stderrLines = []',
    '    child = spawn(binaryPath, commandArgs, {',
    '      cwd: projectRoot,',
    '      env: process.env,',
    '      stdio: [\'inherit\', \'pipe\', \'pipe\'],',
    '    })',
    '    forwardedSignal = null',
    '',
    '    pipeOutput(child.stdout, process.stdout)',
    '    pipeOutput(child.stderr, process.stderr, line => {',
    '      if (stderrLines.length >= maxStderrLines) {',
    '        stderrLines.shift()',
    '      }',
    '      stderrLines.push(line)',
    '    })',
    '',
    '    const result = await new Promise((resolve, reject) => {',
    '      child.on(\'error\', reject)',
    '      child.on(\'close\', (code, signal) => resolve({ code, signal }))',
    '    })',
    '',
    '    if (result.code === 0) {',
    '      process.exit(0)',
    '    }',
    '',
    '    const conflictInfo = extractNextConflictInfo(stderrLines)',
    '    if (!restartedAfterConflict && conflictInfo) {',
    '      const stopped = await stopStaleNextDevServer(conflictInfo.pid, conflictInfo.dir)',
    '      if (stopped) {',
    '        restartedAfterConflict = true',
    '        console.error(`[holo] Stopped stale Next dev server ${conflictInfo.pid}. Restarting dev server.`)',
    '        continue',
    '      }',
    '    }',
    '',
    '    if (result.signal) {',
    '      detachSignalForwarders()',
    '      process.kill(process.pid, result.signal)',
    '    } else {',
    '      process.exit(result.code ?? 1)',
    '    }',
    '  }',
    '}',
    '',
    'run().catch((error) => {',
    '  console.error(error instanceof Error ? error.message : String(error))',
    '  process.exit(1)',
    '})',
    '',
  ].join('\n')
}

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
    dependencies['vue-router'] = '^5.0.4'
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
        ? 'npx eslint app.vue config server tests --fix --no-warn-ignored'
        : options.framework === 'next'
          ? 'npx eslint app config server tests --fix --no-warn-ignored'
          : 'npx eslint src config server tests --fix --no-warn-ignored',
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
