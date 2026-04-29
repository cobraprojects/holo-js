import packageJson from '../package.json' with { type: 'json' }

export const HOLO_PACKAGE_VERSION = packageJson.version
export const ESBUILD_PACKAGE_VERSION = '^0.27.4'
const HOLO_PACKAGE_RANGE = `^${HOLO_PACKAGE_VERSION}`

export const SCAFFOLD_PACKAGE_MANAGER_VERSIONS = Object.freeze({
  bun: 'bun@1.3.9',
  npm: 'npm@latest',
  pnpm: 'pnpm@latest',
  yarn: 'yarn@stable',
} as const)

export const SCAFFOLD_FRAMEWORK_VERSIONS = Object.freeze({
  nuxt: '^3.17.0',
  next: '^16.0.0',
  sveltekit: '^2.0.0',
} as const)

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
