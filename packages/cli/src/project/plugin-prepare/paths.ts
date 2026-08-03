import { lstat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const DRIVE_PATH = /^[a-z]:/i
const PROTECTED_NAMES = new Set([
  '.git',
  '.holo-js',
  'node_modules',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'dist',
  'build',
])
const PROTECTED_FILES = new Set([
  'package.json',
  'bun.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
])
const HOSTED_AUTH_PROVIDERS = ['clerk', 'workos'] as const
const RESERVED_SCAFFOLD_FILES = new Set([
  '.gitignore',
  '.vscode/settings.json',
  'eslint.config.mjs',
  'tsconfig.json',
  'app/app.vue',
  'nuxt.config.ts',
  'shared/.gitkeep',
  'server/api/auth/user.get.ts',
  'next.config.ts',
  'next-env.d.ts',
  'app/layout.tsx',
  'app/page.tsx',
  'app/api/auth/user/route.ts',
  'app/storage/[[...path]]/route.ts',
  'app/broadcasting/config/route.ts',
  'app/broadcasting/auth/route.ts',
  'app/holo/realtime/query/route.ts',
  'app/holo/realtime/mutation/route.ts',
  'svelte.config.js',
  'vite.config.ts',
  'src/hooks.ts',
  'src/hooks.server.ts',
  'src/app.html',
  'src/routes/+page.svelte',
  ...HOSTED_AUTH_PROVIDERS.flatMap(provider => [
    `server/api/auth/${provider}/login.get.ts`,
    `server/api/auth/${provider}/register.get.ts`,
    `server/api/auth/${provider}/callback.get.ts`,
    `server/api/auth/${provider}/logout.post.ts`,
    `app/api/auth/${provider}/login/route.ts`,
    `app/api/auth/${provider}/register/route.ts`,
    `app/api/auth/${provider}/callback/route.ts`,
    `app/api/auth/${provider}/logout/route.ts`,
    `src/routes/api/auth/${provider}/login/+server.ts`,
    `src/routes/api/auth/${provider}/register/+server.ts`,
    `src/routes/api/auth/${provider}/callback/+server.ts`,
    `src/routes/api/auth/${provider}/logout/+server.ts`,
  ]),
].map(platformPathKey))

export function normalizeArtifactPath(path: string, allowRoot = false): string {
  if (!path || path.includes('\0') || path.includes('\\') || isAbsolute(path) || DRIVE_PATH.test(path)) {
    throw new Error(`Invalid project artifact path: ${JSON.stringify(path)}.`)
  }

  const segments = path.split('/')
  if ((!allowRoot && segments.length === 0) || segments.some(segment => !segment || segment === '..' || (segment === '.' && !allowRoot))) {
    throw new Error(`Invalid project artifact path: ${JSON.stringify(path)}.`)
  }

  if (allowRoot && path === '.') {
    return path
  }

  if (segments.some(segment => segment === '.')) {
    throw new Error(`Invalid project artifact path: ${JSON.stringify(path)}.`)
  }

  return path
}

export function assertManagedPathAllowed(path: string, configPaths: readonly string[]): void {
  const pathKey = platformPathKey(path)
  const first = pathKey.split('/')[0] ?? ''
  const fileName = pathKey.split('/').at(-1) ?? ''
  if (
    PROTECTED_NAMES.has(first)
    || first === 'config'
    || PROTECTED_FILES.has(pathKey)
    || fileName === '.env'
    || fileName.startsWith('.env.')
    || configPaths.some(configPath => pathKey === platformPathKey(configPath))
    || RESERVED_SCAFFOLD_FILES.has(pathKey)
  ) {
    throw new Error(`Protected managed project artifact path: ${path}.`)
  }
}

export function resolveContainedPath(root: string, path: string): string {
  const target = resolve(root, ...path.split('/'))
  const relativePath = relative(root, target)
  if (relativePath.startsWith('..') || relativePath === '' || relativePath.split(sep).includes('..')) {
    throw new Error(`Project artifact path escapes its allowed root: ${path}.`)
  }
  return target
}

export async function assertNoSymbolicLinkParents(root: string, target: string): Promise<void> {
  const rootStats = await lstat(root).catch(() => undefined)
  if (rootStats?.isSymbolicLink()) {
    throw new Error(`Project artifact root must not be a symbolic link: ${root}.`)
  }
  const relativePath = relative(root, target)
  const segments = relativePath.split(sep).slice(0, -1)
  let current = root
  for (const segment of segments) {
    current = resolve(current, segment)
    const stats = await lstat(current).catch(() => undefined)
    if (stats?.isSymbolicLink()) {
      throw new Error(`Project artifact parent must not be a symbolic link: ${relative(root, current)}.`)
    }
  }
}

export async function assertNoSymbolicLinks(root: string, target: string): Promise<void> {
  await assertNoSymbolicLinkParents(root, target)
  const targetStats = await lstat(target).catch(() => undefined)
  if (targetStats?.isSymbolicLink()) {
    throw new Error(`Project artifact must not be a symbolic link: ${relative(root, target)}.`)
  }
}

export function isPathInside(root: string, target: string): boolean {
  const relativePath = relative(resolve(root), resolve(target))
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

export function platformPathKey(path: string): string {
  return process.platform === 'darwin' || process.platform === 'win32' ? path.toLocaleLowerCase() : path
}
