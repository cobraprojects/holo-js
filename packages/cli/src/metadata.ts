import packageJson from '../package.json' with { type: 'json' }
import { WORKSPACE_CATALOG } from './generated/workspaceCatalog'

export const HOLO_PACKAGE_VERSION = packageJson.version
const HOLO_PACKAGE_RANGE = `^${HOLO_PACKAGE_VERSION}`

function catalogVersion<TPackageName extends keyof typeof WORKSPACE_CATALOG>(
  packageName: TPackageName,
): (typeof WORKSPACE_CATALOG)[TPackageName] {
  return WORKSPACE_CATALOG[packageName]
}

export const ESBUILD_PACKAGE_VERSION = catalogVersion('esbuild')

export const SCAFFOLD_PACKAGE_MANAGER_VERSIONS = Object.freeze({
  npm: 'npm@latest',
  pnpm: 'pnpm@latest',
  yarn: 'yarn@stable',
  bun: 'bun@1.3.9',
} as const)

export const SCAFFOLD_FRAMEWORK_VERSIONS = Object.freeze({
  nuxt: catalogVersion('nuxt'),
  next: catalogVersion('next'),
  sveltekit: catalogVersion('@sveltejs/kit'),
} as const)

export const SCAFFOLD_NEXT_REACT_VERSIONS = Object.freeze({
  react: catalogVersion('react'),
  'react-dom': catalogVersion('react-dom'),
  '@types/react': catalogVersion('@types/react'),
  '@types/react-dom': catalogVersion('@types/react-dom'),
} as const)

export const SCAFFOLD_BASE_DEV_DEPENDENCY_VERSIONS = Object.freeze({
  typescript: catalogVersion('typescript'),
  '@types/node': catalogVersion('@types/node'),
  eslint: catalogVersion('eslint'),
} as const)

export const SCAFFOLD_NUXT_DEPENDENCY_VERSIONS = Object.freeze({
  vue: catalogVersion('vue'),
  'vue-router': catalogVersion('vue-router'),
  'vue-tsc': catalogVersion('vue-tsc'),
} as const)

export const SCAFFOLD_SVELTEKIT_DEPENDENCY_VERSIONS = Object.freeze({
  '@sveltejs/adapter-node': catalogVersion('@sveltejs/adapter-node'),
  '@sveltejs/vite-plugin-svelte': catalogVersion('@sveltejs/vite-plugin-svelte'),
  svelte: catalogVersion('svelte'),
  vite: catalogVersion('vite'),
} as const)

export const IOREDIS_PACKAGE_VERSION = catalogVersion('ioredis')

export const SCAFFOLD_FRAMEWORK_ADAPTER_VERSIONS = Object.freeze({
  nuxt: HOLO_PACKAGE_RANGE,
  next: HOLO_PACKAGE_RANGE,
  sveltekit: HOLO_PACKAGE_RANGE,
} as const)

export const SCAFFOLD_FRAMEWORK_RUNTIME_VERSIONS = Object.freeze({
  nuxt: {
    '@holo-js/storage': HOLO_PACKAGE_RANGE,
  },
  next: {
    '@holo-js/storage': HOLO_PACKAGE_RANGE,
  },
  sveltekit: {
    '@holo-js/storage': HOLO_PACKAGE_RANGE,
  },
} as const)
