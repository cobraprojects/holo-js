import {
  normalizeScaffoldOptionalPackages,
  type ProjectScaffoldOptions,
} from '../shared'
import type { AuthInstallFeatures, ScaffoldedFile } from './types'

type HostedAuthProvider = 'clerk' | 'workos'

type HostedAuthProviderSpec = {
  readonly provider: HostedAuthProvider
  readonly packageName: string
  readonly loginFunction: string
  readonly registerFunction: string
  readonly callbackFunction: string
  readonly logoutFunction: string
}

const HOSTED_AUTH_PROVIDERS = {
  workos: {
    provider: 'workos',
    packageName: '@holo-js/auth-workos',
    loginFunction: 'loginWithWorkos',
    registerFunction: 'registerWithWorkos',
    callbackFunction: 'completeWorkosAuth',
    logoutFunction: 'logoutWithWorkos',
  },
  clerk: {
    provider: 'clerk',
    packageName: '@holo-js/auth-clerk',
    loginFunction: 'loginWithClerk',
    registerFunction: 'registerWithClerk',
    callbackFunction: 'completeClerkAuth',
    logoutFunction: 'logoutWithClerk',
  },
} as const satisfies Record<HostedAuthProvider, HostedAuthProviderSpec>

function getRequestedHostedAuthProviders(features: AuthInstallFeatures): readonly HostedAuthProvider[] {
  return [
    ...(features.workos ? ['workos'] as const : []),
    ...(features.clerk ? ['clerk'] as const : []),
  ]
}

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

function renderNuxtCurrentAuthRoute(): string {
  return [
    'import auth, { check, isAuthError, provider, user } from \'@holo-js/auth\'',
    'import { setResponseStatus } from \'h3\'',
    '',
    'export default defineEventHandler(async (event) => {',
    '  const query = getQuery(event)',
    '  const guard = typeof query.guard === \'string\' ? query.guard : undefined',
    '  try {',
    '    const guardAuth = guard ? auth.guard(guard) : undefined',
    '',
    '    return {',
    '      authenticated: guardAuth ? await guardAuth.check() : await check(),',
    '      guard: guard ?? \'web\',',
    '      provider: guardAuth ? await guardAuth.provider() : await provider(),',
    '      user: guardAuth ? await guardAuth.user() : await user(),',
    '    }',
    '  } catch (error) {',
    '    if (isAuthError(error) && error.code === \'guard_not_configured\') {',
    '      setResponseStatus(event, 400)',
    '',
    '      return {',
    '        authenticated: false,',
    '        guard: guard ?? \'web\',',
    '        provider: null,',
    '        user: null,',
    '      }',
    '    }',
    '',
    '    throw error',
    '  }',
    '})',
    '',
  ].join('\n')
}

function renderNuxtHostedAuthLoginRoute(spec: HostedAuthProviderSpec): string {
  return [
    `import { ${spec.loginFunction} } from '${spec.packageName}'`,
    '',
    'export default defineEventHandler(async (event) => {',
    `  return await ${spec.loginFunction}(event)`,
    '})',
    '',
  ].join('\n')
}

function renderNuxtHostedAuthRegisterRoute(spec: HostedAuthProviderSpec): string {
  return [
    `import { ${spec.registerFunction} } from '${spec.packageName}'`,
    '',
    'export default defineEventHandler(async (event) => {',
    `  return await ${spec.registerFunction}(event)`,
    '})',
    '',
  ].join('\n')
}

function renderNuxtHostedAuthCallbackRoute(spec: HostedAuthProviderSpec): string {
  return [
    `import { ${spec.callbackFunction} } from '${spec.packageName}'`,
    'import { sendRedirect } from \'h3\'',
    '',
    'export default defineEventHandler(async (event) => {',
    `  const { error } = await ${spec.callbackFunction}(event)`,
    '  if (error) {',
    '    return await sendRedirect(event, `/login?error=${encodeURIComponent(error.code)}`, 303)',
    '  }',
    '',
    '  return await sendRedirect(event, \'/\', 303)',
    '})',
    '',
  ].join('\n')
}

function renderNuxtHostedAuthLogoutRoute(spec: HostedAuthProviderSpec): string {
  return [
    'import { provider } from \'@holo-js/auth\'',
    `import { ${spec.logoutFunction} } from '${spec.packageName}'`,
    'import { createError, sendRedirect } from \'h3\'',
    '',
    'export default defineEventHandler(async (event) => {',
    '  let currentProvider: string | null',
    '  try {',
    '    currentProvider = await provider()',
    '  } catch {',
    '    return await sendRedirect(event, \'/\', 303)',
    '  }',
    '',
    `  if (currentProvider !== '${spec.provider}') {`,
    '    return await sendRedirect(event, \'/\', 303)',
    '  }',
    '',
    `  const { data, error } = await ${spec.logoutFunction}(event)`,
    '  if (error) {',
    '    throw createError({',
    '      statusCode: error.status,',
    '      statusMessage: error.message,',
    '    })',
    '  }',
    '',
    '  return await sendRedirect(event, data.url, 303)',
    '})',
    '',
  ].join('\n')
}

function renderNuxtHostedAuthRouteFiles(provider: HostedAuthProvider): readonly ScaffoldedFile[] {
  const spec = HOSTED_AUTH_PROVIDERS[provider]
  return [
    { path: `server/api/auth/${provider}/login.get.ts`, contents: renderNuxtHostedAuthLoginRoute(spec) },
    { path: `server/api/auth/${provider}/register.get.ts`, contents: renderNuxtHostedAuthRegisterRoute(spec) },
    { path: `server/api/auth/${provider}/callback.get.ts`, contents: renderNuxtHostedAuthCallbackRoute(spec) },
    { path: `server/api/auth/${provider}/logout.post.ts`, contents: renderNuxtHostedAuthLogoutRoute(spec) },
  ]
}

function renderNextConfig(): string {
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

function renderNextRouteBridge(modulePath: string, methods: readonly string[]): string {
  return [
    `export { ${methods.join(', ')} } from '${modulePath}'`,
    '',
  ].join('\n')
}

export function renderNextHoloHelper(): string {
  return [
    'import { dirname, resolve } from \'node:path\'',
    'import { fileURLToPath } from \'node:url\'',
    'import { createNextHoloHelpers } from \'@holo-js/adapter-next/runtime\'',
    '',
    'const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), \'../../..\')',
    '',
    'export const holo = createNextHoloHelpers({ projectRoot })',
    '',
  ].join('\n')
}

export function renderNextRuntimeBootstrap(): string {
  return [
    'import { dirname, resolve } from \'node:path\'',
    'import { fileURLToPath } from \'node:url\'',
    'import { createNextHoloHelpers } from \'@holo-js/adapter-next/runtime\'',
    '',
    'const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), \'../../..\')',
    'const holo = createNextHoloHelpers({ projectRoot })',
    '',
    'await holo.getApp()',
    '',
  ].join('\n')
}

function renderNextCurrentAuthRoute(): string {
  return [
    'import auth, { check, isAuthError, provider, user } from \'@holo-js/auth\'',
    '',
    'export async function GET(request: Request) {',
    '  const guard = new URL(request.url).searchParams.get(\'guard\') ?? undefined',
    '  try {',
    '    const guardAuth = guard ? auth.guard(guard) : undefined',
    '',
    '    return Response.json({',
    '      authenticated: guardAuth ? await guardAuth.check() : await check(),',
    '      guard: guard ?? \'web\',',
    '      provider: guardAuth ? await guardAuth.provider() : await provider(),',
    '      user: guardAuth ? await guardAuth.user() : await user(),',
    '    })',
    '  } catch (error) {',
    '    if (isAuthError(error) && error.code === \'guard_not_configured\') {',
    '      return Response.json({',
    '        authenticated: false,',
    '        guard: guard ?? \'web\',',
    '        provider: null,',
    '        user: null,',
    '      }, { status: 400 })',
    '    }',
    '',
    '    throw error',
    '  }',
    '}',
    '',
  ].join('\n')
}

function renderNextHostedAuthLoginRoute(spec: HostedAuthProviderSpec): string {
  return renderNextRouteBridge(`../../../../../.holo-js/generated/next/auth-${spec.provider}-login-route`, ['GET'])
}

function renderNextGeneratedHostedAuthLoginRoute(spec: HostedAuthProviderSpec): string {
  return [
    `import { ${spec.loginFunction} } from '${spec.packageName}'`,
    'import { holo } from \'./holo\'',
    '',
    'export async function GET(request: Request) {',
    '  await holo.getApp()',
    '',
    `  return await ${spec.loginFunction}(request)`,
    '}',
    '',
  ].join('\n')
}

function renderNextHostedAuthRegisterRoute(spec: HostedAuthProviderSpec): string {
  return renderNextRouteBridge(`../../../../../.holo-js/generated/next/auth-${spec.provider}-register-route`, ['GET'])
}

function renderNextGeneratedHostedAuthRegisterRoute(spec: HostedAuthProviderSpec): string {
  return [
    `import { ${spec.registerFunction} } from '${spec.packageName}'`,
    'import { holo } from \'./holo\'',
    '',
    'export async function GET(request: Request) {',
    '  await holo.getApp()',
    '',
    `  return await ${spec.registerFunction}(request)`,
    '}',
    '',
  ].join('\n')
}

function renderNextHostedAuthCallbackRoute(spec: HostedAuthProviderSpec): string {
  return renderNextRouteBridge(`../../../../../.holo-js/generated/next/auth-${spec.provider}-callback-route`, ['GET'])
}

function renderNextGeneratedHostedAuthCallbackRoute(spec: HostedAuthProviderSpec): string {
  return [
    `import { ${spec.callbackFunction} } from '${spec.packageName}'`,
    'import { holo } from \'./holo\'',
    '',
    'export async function GET(request: Request) {',
    '  await holo.getApp()',
    '',
    `  const { error } = await ${spec.callbackFunction}(request)`,
    '  if (error) {',
    '    return Response.redirect(new URL(`/login?error=${encodeURIComponent(error.code)}`, request.url))',
    '  }',
    '',
    '  return Response.redirect(new URL(\'/\', request.url))',
    '}',
    '',
  ].join('\n')
}

function renderNextHostedAuthLogoutRoute(spec: HostedAuthProviderSpec): string {
  return renderNextRouteBridge(`../../../../../.holo-js/generated/next/auth-${spec.provider}-logout-route`, ['POST'])
}

function renderNextGeneratedHostedAuthLogoutRoute(spec: HostedAuthProviderSpec): string {
  return [
    'import { provider } from \'@holo-js/auth\'',
    `import { ${spec.logoutFunction} } from '${spec.packageName}'`,
    'import { holo } from \'./holo\'',
    '',
    'export async function POST(request: Request) {',
    '  await holo.getApp()',
    '',
    '  let currentProvider: string | null',
    '  try {',
    '    currentProvider = await provider()',
    '  } catch {',
    '    return Response.redirect(new URL(\'/\', request.url), 303)',
    '  }',
    '',
    `  if (currentProvider !== '${spec.provider}') {`,
    '    return Response.redirect(new URL(\'/\', request.url), 303)',
    '  }',
    '',
    `  const { data, error } = await ${spec.logoutFunction}(request)`,
    '  if (error) {',
    '    return Response.json({ data, error }, { status: error.status })',
    '  }',
    '',
    '  return Response.redirect(data.url, 303)',
    '}',
    '',
  ].join('\n')
}

function renderNextHostedAuthRouteFiles(provider: HostedAuthProvider): readonly ScaffoldedFile[] {
  const spec = HOSTED_AUTH_PROVIDERS[provider]
  return [
    { path: `app/api/auth/${provider}/login/route.ts`, contents: renderNextHostedAuthLoginRoute(spec) },
    { path: `app/api/auth/${provider}/register/route.ts`, contents: renderNextHostedAuthRegisterRoute(spec) },
    { path: `app/api/auth/${provider}/callback/route.ts`, contents: renderNextHostedAuthCallbackRoute(spec) },
    { path: `app/api/auth/${provider}/logout/route.ts`, contents: renderNextHostedAuthLogoutRoute(spec) },
  ]
}

function renderNextStorageRoute(): string {
  return renderNextRouteBridge('../../../.holo-js/generated/next/storage-route', ['GET'])
}

function renderNextGeneratedStorageRoute(): string {
  return [
    'import { createPublicStorageResponse } from \'@holo-js/storage\'',
    'import { holo } from \'./holo\'',
    '',
    'export async function GET(request: Request) {',
    '  const app = await holo.getApp()',
    '  return createPublicStorageResponse(app.projectRoot, app.config.storage, request)',
    '}',
    '',
  ].join('\n')
}

export function renderNextBroadcastAuthRoute(): string {
  return renderNextRouteBridge('../../../.holo-js/generated/next/broadcast-auth-route', ['POST'])
}

export function renderNextBroadcastConfigRoute(): string {
  return renderNextRouteBridge('../../../.holo-js/generated/next/broadcast-config-route', ['GET'])
}

export function renderNextGeneratedBroadcastConfigRoute(): string {
  return [
    'import { renderBroadcastClientConfigResponse } from \'@holo-js/broadcast/client-config\'',
    'import { holo } from \'./holo\'',
    '',
    'export async function GET() {',
    '  const app = await holo.getApp()',
    '  return renderBroadcastClientConfigResponse(app.config.broadcast)',
    '}',
    '',
  ].join('\n')
}

export function renderNextGeneratedBroadcastAuthRoute(): string {
  return [
    'import { renderBroadcastAuthResponse } from \'@holo-js/broadcast/auth\'',
    'import { importBroadcastChannelModule } from \'../channel-importer\'',
    'import { holo } from \'./holo\'',
    '',
    'export async function POST(request: Request) {',
    '  const app = await holo.getApp()',
    '  const auth = await holo.getAuth()',
    '',
    '  return await renderBroadcastAuthResponse(request, {',
    '    resolveUser: async (_request, context) => {',
    '      const guardAuth = context.guard ? auth?.guard(context.guard) : undefined',
    '      return guardAuth ? await guardAuth.user() : await auth?.user()',
    '    },',
    '    channelAuth: {',
    '      registry: {',
    '        projectRoot: app.projectRoot,',
    '        channels: app.registry?.channels ?? [],',
    '      },',
    '      importModule: importBroadcastChannelModule,',
    '    },',
    '  })',
    '}',
    '',
  ].join('\n')
}

export function renderNextManagedRouteFiles(options: {
  readonly authEnabled?: boolean
  readonly broadcastEnabled?: boolean
  readonly storageEnabled?: boolean
  readonly broadcastAuthEnabled?: boolean
} = {}): readonly ScaffoldedFile[] {
  return [
    { path: '.holo-js/generated/next/holo.ts', contents: renderNextHoloHelper() },
    { path: '.holo-js/generated/next/bootstrap.mjs', contents: renderNextRuntimeBootstrap() },
    ...(options.storageEnabled
      ? [{ path: '.holo-js/generated/next/storage-route.ts', contents: renderNextGeneratedStorageRoute() }]
      : []),
    ...(options.broadcastEnabled
      ? [{ path: '.holo-js/generated/next/broadcast-config-route.ts', contents: renderNextGeneratedBroadcastConfigRoute() }]
      : []),
    ...(options.broadcastAuthEnabled
      ? [{ path: '.holo-js/generated/next/broadcast-auth-route.ts', contents: renderNextGeneratedBroadcastAuthRoute() }]
      : []),
  ]
}

export function renderNextManagedHostedAuthRouteFiles(features: AuthInstallFeatures): readonly ScaffoldedFile[] {
  const providers = getRequestedHostedAuthProviders(features)
  if (providers.length === 0) {
    return []
  }

  return [
    { path: '.holo-js/generated/next/holo.ts', contents: renderNextHoloHelper() },
    { path: '.holo-js/generated/next/bootstrap.mjs', contents: renderNextRuntimeBootstrap() },
    ...providers.flatMap((provider) => {
      const spec = HOSTED_AUTH_PROVIDERS[provider]
      return [
        { path: `.holo-js/generated/next/auth-${provider}-login-route.ts`, contents: renderNextGeneratedHostedAuthLoginRoute(spec) },
        { path: `.holo-js/generated/next/auth-${provider}-register-route.ts`, contents: renderNextGeneratedHostedAuthRegisterRoute(spec) },
        { path: `.holo-js/generated/next/auth-${provider}-callback-route.ts`, contents: renderNextGeneratedHostedAuthCallbackRoute(spec) },
        { path: `.holo-js/generated/next/auth-${provider}-logout-route.ts`, contents: renderNextGeneratedHostedAuthLogoutRoute(spec) },
      ]
    }),
  ]
}

export function renderSvelteManagedRuntimeFiles(): readonly ScaffoldedFile[] {
  return [
    { path: '.holo-js/generated/sveltekit/holo.ts', contents: renderSvelteHoloHelper() },
  ]
}

function renderSvelteConfig(): string {
  return [
    'import adapter from \'@sveltejs/adapter-node\'',
    'import { withHoloSvelteKit } from \'@holo-js/adapter-sveltekit/config\'',
    'import { vitePreprocess } from \'@sveltejs/vite-plugin-svelte\'',
    '',
    '/** @type {import(\'@sveltejs/kit\').Config} */',
    'const config = withHoloSvelteKit({',
    '  preprocess: vitePreprocess(),',
    '  kit: {',
    '    adapter: adapter(),',
    '  },',
    '})',
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

function renderSvelteViteConfig(_storageEnabled: boolean): string {
  const externals = [
    '      \'@holo-js/adapter-sveltekit\',',
    '      \'@holo-js/auth\',',
    '      \'@holo-js/auth-clerk\',',
    '      \'@holo-js/auth-social\',',
    '      \'@holo-js/auth-workos\',',
    '      \'@holo-js/authorization\',',
    '      \'@holo-js/broadcast\',',
    '      \'@holo-js/cache\',',
    '      \'@holo-js/cache-db\',',
    '      \'@holo-js/cache-redis\',',
    '      \'@holo-js/config\',',
    '      \'@holo-js/core\',',
    '      \'@holo-js/db\',',
    '      \'@holo-js/db-mysql\',',
    '      \'@holo-js/db-postgres\',',
    '      \'@holo-js/db-sqlite\',',
    '      \'@holo-js/events\',',
    '      \'@holo-js/flux\',',
    '      \'@holo-js/flux-svelte\',',
    '      \'@holo-js/forms\',',
    '      \'@holo-js/mail\',',
    '      \'@holo-js/media\',',
    '      \'@holo-js/notifications\',',
    '      \'@holo-js/queue\',',
    '      \'@holo-js/queue-db\',',
    '      \'@holo-js/queue-redis\',',
    '      \'@holo-js/security\',',
    '      \'@holo-js/session\',',
    '      \'@holo-js/storage\',',
    '      \'@holo-js/storage/runtime\',',
    '      \'@holo-js/storage-s3\',',
    '      \'@holo-js/validation\',',
    '      \'better-sqlite3\',',
    '      \'ioredis\',',
    '      \'mysql2\',',
    '      \'pg\',',
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
    'import { dirname, resolve } from \'node:path\'',
    'import { fileURLToPath } from \'node:url\'',
    'import { createSvelteKitHoloHelpers } from \'@holo-js/adapter-sveltekit\'',
    '',
    'const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), \'../../..\')',
    '',
    'export const holo = createSvelteKitHoloHelpers({ projectRoot })',
    '',
  ].join('\n')
}

function renderSvelteHostedAuthLoginRoute(spec: HostedAuthProviderSpec): string {
  return [
    `import { ${spec.loginFunction} } from '${spec.packageName}'`,
    'import type { RequestEvent } from \'@sveltejs/kit\'',
    '',
    'export async function GET(event: RequestEvent) {',
    `  return await ${spec.loginFunction}(event)`,
    '}',
    '',
  ].join('\n')
}

function renderSvelteHostedAuthRegisterRoute(spec: HostedAuthProviderSpec): string {
  return [
    `import { ${spec.registerFunction} } from '${spec.packageName}'`,
    'import type { RequestEvent } from \'@sveltejs/kit\'',
    '',
    'export async function GET(event: RequestEvent) {',
    `  return await ${spec.registerFunction}(event)`,
    '}',
    '',
  ].join('\n')
}

function renderSvelteHostedAuthCallbackRoute(spec: HostedAuthProviderSpec): string {
  return [
    'import { redirect, type RequestEvent } from \'@sveltejs/kit\'',
    `import { ${spec.callbackFunction} } from '${spec.packageName}'`,
    '',
    'export async function GET(event: RequestEvent) {',
    `  const { error } = await ${spec.callbackFunction}(event)`,
    '  if (error) {',
    '    throw redirect(303, `/login?error=${encodeURIComponent(error.code)}`)',
    '  }',
    '',
    '  throw redirect(303, \'/\')',
    '}',
    '',
  ].join('\n')
}

function renderSvelteHostedAuthLogoutRoute(spec: HostedAuthProviderSpec): string {
  return [
    'import { redirect, type RequestEvent } from \'@sveltejs/kit\'',
    'import { provider } from \'@holo-js/auth\'',
    `import { ${spec.logoutFunction} } from '${spec.packageName}'`,
    '',
    'export async function POST(event: RequestEvent) {',
    '  let currentProvider: string | null',
    '  try {',
    '    currentProvider = await provider()',
    '  } catch {',
    '    throw redirect(303, \'/\')',
    '  }',
    '',
    `  if (currentProvider !== '${spec.provider}') {`,
    '    throw redirect(303, \'/\')',
    '  }',
    '',
    `  const { data, error } = await ${spec.logoutFunction}(event)`,
    '  if (error) {',
    '    return Response.json({ data, error }, { status: error.status })',
    '  }',
    '',
    '  throw redirect(303, data.url)',
    '}',
    '',
  ].join('\n')
}

function renderSvelteHostedAuthRouteFiles(provider: HostedAuthProvider): readonly ScaffoldedFile[] {
  const spec = HOSTED_AUTH_PROVIDERS[provider]
  return [
    { path: `src/routes/api/auth/${provider}/login/+server.ts`, contents: renderSvelteHostedAuthLoginRoute(spec) },
    { path: `src/routes/api/auth/${provider}/register/+server.ts`, contents: renderSvelteHostedAuthRegisterRoute(spec) },
    { path: `src/routes/api/auth/${provider}/callback/+server.ts`, contents: renderSvelteHostedAuthCallbackRoute(spec) },
    { path: `src/routes/api/auth/${provider}/logout/+server.ts`, contents: renderSvelteHostedAuthLogoutRoute(spec) },
    ...renderSvelteManagedRuntimeFiles(),
  ]
}

export function renderAuthProviderRouteFiles(
  framework: ProjectScaffoldOptions['framework'],
  features: AuthInstallFeatures,
): readonly ScaffoldedFile[] {
  return getRequestedHostedAuthProviders(features).flatMap((provider) => {
    if (framework === 'nuxt') {
      return renderNuxtHostedAuthRouteFiles(provider)
    }

    if (framework === 'next') {
      return renderNextHostedAuthRouteFiles(provider)
    }

    return renderSvelteHostedAuthRouteFiles(provider)
  })
}

export function renderAuthRouteFiles(framework: ProjectScaffoldOptions['framework']): readonly ScaffoldedFile[] {
  if (framework === 'next') {
    return [
      { path: 'app/api/auth/user/route.ts', contents: renderNextCurrentAuthRoute() },
      { path: '.holo-js/generated/next/holo.ts', contents: renderNextHoloHelper() },
      { path: '.holo-js/generated/next/bootstrap.mjs', contents: renderNextRuntimeBootstrap() },
    ]
  }

  if (framework === 'nuxt') {
    return [
      { path: 'server/api/auth/user.get.ts', contents: renderNuxtCurrentAuthRoute() },
    ]
  }

  return [
    ...renderSvelteManagedRuntimeFiles(),
  ]
}

export function renderFrameworkFiles(options: ProjectScaffoldOptions): readonly ScaffoldedFile[] {
  const optionalPackages = normalizeScaffoldOptionalPackages(options.optionalPackages)
  const storageEnabled = optionalPackages.includes('storage')
  const authEnabled = optionalPackages.includes('auth')
  const broadcastEnabled = optionalPackages.includes('broadcast')

  if (options.framework === 'nuxt') {
    return [
      { path: 'app/app.vue', contents: renderNuxtAppVue(options.projectName) },
      { path: 'nuxt.config.ts', contents: renderNuxtConfig() },
      { path: 'shared/.gitkeep', contents: '' },
      ...(authEnabled
        ? renderAuthRouteFiles('nuxt')
        : []),
    ]
  }

  if (options.framework === 'next') {
    return [
      { path: 'next.config.ts', contents: renderNextConfig() },
      { path: 'next-env.d.ts', contents: renderNextEnvDts() },
      { path: 'app/layout.tsx', contents: renderNextLayout(options.projectName) },
      { path: 'app/page.tsx', contents: renderNextPage(options.projectName) },
      ...(authEnabled
        ? [{ path: 'app/api/auth/user/route.ts', contents: renderNextCurrentAuthRoute() }]
        : []),
      ...(storageEnabled
        ? [{ path: 'app/storage/[[...path]]/route.ts', contents: renderNextStorageRoute() }]
        : []),
      ...(broadcastEnabled
        ? [{ path: 'app/broadcasting/config/route.ts', contents: renderNextBroadcastConfigRoute() }]
        : []),
      ...renderNextManagedRouteFiles({ authEnabled, broadcastEnabled, storageEnabled }),
    ]
  }

  return [
    { path: 'svelte.config.js', contents: renderSvelteConfig() },
    { path: 'vite.config.ts', contents: renderSvelteViteConfig(storageEnabled) },
    { path: 'src/hooks.ts', contents: renderSvelteUserHooks() },
    { path: 'src/hooks.server.ts', contents: renderSvelteServerUserHooks() },
    { path: 'src/app.html', contents: renderSvelteAppHtml() },
    { path: 'src/routes/+page.svelte', contents: renderSveltePage(options.projectName) },
    ...(authEnabled
      ? renderAuthRouteFiles('sveltekit')
      : []),
    ...renderSvelteManagedRuntimeFiles(),
  ]
}

export function renderFrameworkRunner(options: Pick<ProjectScaffoldOptions, 'framework'>): string {
  const commandName = options.framework === 'nuxt'
    ? 'nuxt'
    : options.framework === 'next'
      ? 'next'
      : 'vite'
  return [
    'import { existsSync, readFileSync, readlinkSync } from \'node:fs\'',
    'import { dirname, resolve } from \'node:path\'',
    'import { fileURLToPath, pathToFileURL } from \'node:url\'',
    'import { execFileSync, spawn } from \'node:child_process\'',
    '',
    'const mode = process.argv[2]',
    'const manifestPath = fileURLToPath(new URL(\'./project.json\', import.meta.url))',
    'const projectRoot = resolve(dirname(manifestPath), \'../..\')',
    'const runtimeSchemaPath = resolve(projectRoot, \'.holo-js/generated/schema.mjs\')',
    'const nextRuntimeBootstrapPath = resolve(projectRoot, \'.holo-js/generated/next/bootstrap.mjs\')',
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
    'function shouldSuppressOutput(line) {',
    '  if (suppressedOutput.has(line)) {',
    '    return true',
    '  }',
    '',
    '  return framework === \'sveltekit\'',
    '    && line.startsWith(\'Circular dependency: \')',
    '    && line.includes(\'/node_modules/semver/\')',
    '}',
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
    '      if (!shouldSuppressOutput(line)) {',
    '        target.write(`${line}\\n`)',
    '      }',
    '    }',
    '  })',
    '',
    '  stream.on(\'end\', () => {',
    '    if (buffered.length > 0) {',
    '      onLine?.(buffered)',
    '    }',
    '    if (buffered.length > 0 && !shouldSuppressOutput(buffered)) {',
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
    '  } catch {',
    '    // Fall through to the portable process inspection path below.',
    '  }',
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
    'async function stopStaleNextDevServer(pid, reportedDir, force = false) {',
    '  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {',
    '    return false',
    '  }',
    '',
    '  if (!isOwnedNextDevServer(pid, reportedDir)) {',
    '    return false',
    '  }',
    '',
    '  if (!force) {',
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
    '    const childEnv = { ...process.env }',
    '    const preloads = [runtimeSchemaPath]',
    '    if (framework === \'next\') {',
    '      preloads.push(nextRuntimeBootstrapPath)',
    '    }',
    '    const preloadOptions = preloads',
    '      .filter(path => existsSync(path))',
    '      .map(path => `--import=${pathToFileURL(path).href}`)',
    '    if (preloadOptions.length > 0) {',
    '      const preload = preloadOptions.join(\' \')',
    '      childEnv.NODE_OPTIONS = childEnv.NODE_OPTIONS',
    '        ? `${childEnv.NODE_OPTIONS} ${preload}`',
    '        : preload',
    '    }',
    '    child = spawn(binaryPath, commandArgs, {',
    '      cwd: projectRoot,',
    '      env: childEnv,',
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
    '',
    '      // Another dev server is already running (possibly in a different directory).',
    '      // Next.js already printed the conflict message with instructions to kill it.',
    '      // Exit gracefully to avoid noisy npm/bun error cascades.',
    '      process.exit(0)',
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
