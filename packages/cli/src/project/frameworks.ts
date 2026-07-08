import {
  SCAFFOLD_FRAMEWORK_ADAPTER_VERSIONS,
  SCAFFOLD_FRAMEWORK_RUNTIME_VERSIONS,
  SCAFFOLD_FRAMEWORK_VERSIONS,
  SCAFFOLD_NEXT_REACT_VERSIONS,
  SCAFFOLD_NUXT_DEPENDENCY_VERSIONS,
  SCAFFOLD_SVELTEKIT_DEPENDENCY_VERSIONS,
} from '../metadata'

type DependencyMap = Readonly<Record<string, string>>
type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'
type FrameworkSyncCommands = Readonly<Record<PackageManager, readonly [string, ...string[]]>>

export type FrameworkTsconfigKind = 'nuxt' | 'next' | 'sveltekit'

export type FrameworkDescriptor = {
  readonly id: string
  readonly displayName: string
  readonly detectPackages: readonly string[]
  readonly adapterPackage: `@holo-js/${string}`
  readonly fluxPackage?: `@holo-js/${string}`
  readonly scaffold: {
    readonly dependencies: DependencyMap
    readonly devDependencies: DependencyMap
    readonly scripts: DependencyMap
    readonly lintScript: string
    readonly typecheckScript: string
    readonly defaultUrl: string
    readonly tsconfig: FrameworkTsconfigKind
    readonly vscodeVueHybridMode?: boolean
  }
  readonly runner: {
    readonly commandName: string
    readonly buildArgs: readonly string[]
    readonly start: readonly string[]
    readonly startUsesFrameworkBinary: boolean
    readonly preloadNextRuntime: boolean
    readonly suppressSvelteKitOutput: boolean
    readonly nextDevServerConflictHandling: boolean
  }
  readonly sync?: {
    readonly commands: FrameworkSyncCommands
    readonly errorLabel: string
  }
  readonly capabilities: {
    readonly managedBroadcastAuthRoute: boolean
  }
}

export const FRAMEWORK_DESCRIPTORS = {
  nuxt: {
    id: 'nuxt',
    displayName: 'Nuxt',
    detectPackages: ['nuxt'],
    adapterPackage: '@holo-js/adapter-nuxt',
    fluxPackage: '@holo-js/flux-vue',
    scaffold: {
      dependencies: {
        nuxt: SCAFFOLD_FRAMEWORK_VERSIONS.nuxt,
        vue: SCAFFOLD_NUXT_DEPENDENCY_VERSIONS.vue,
        'vue-router': SCAFFOLD_NUXT_DEPENDENCY_VERSIONS['vue-router'],
        '@holo-js/adapter-nuxt': SCAFFOLD_FRAMEWORK_ADAPTER_VERSIONS.nuxt,
      },
      devDependencies: {
        'vue-tsc': SCAFFOLD_NUXT_DEPENDENCY_VERSIONS['vue-tsc'],
      },
      scripts: {
        postinstall: 'nuxt prepare',
      },
      lintScript: 'eslint app config server shared tests *.d.ts --fix --no-warn-ignored --no-error-on-unmatched-pattern',
      typecheckScript: 'nuxt typecheck',
      defaultUrl: 'http://localhost:3000',
      tsconfig: 'nuxt',
      vscodeVueHybridMode: true,
    },
    runner: {
      commandName: 'nuxt',
      buildArgs: ['build'],
      start: ['.output/server/index.mjs'],
      startUsesFrameworkBinary: false,
      preloadNextRuntime: false,
      suppressSvelteKitOutput: false,
      nextDevServerConflictHandling: false,
    },
    sync: {
      commands: {
        bun: ['bun', 'x', 'nuxt', 'prepare'],
        npm: ['npm', 'exec', '--', 'nuxt', 'prepare'],
        pnpm: ['pnpm', 'exec', 'nuxt', 'prepare'],
        yarn: ['yarn', 'run', 'nuxt', 'prepare'],
      },
      errorLabel: 'nuxt prepare',
    },
    capabilities: {
      managedBroadcastAuthRoute: false,
    },
  },
  next: {
    id: 'next',
    displayName: 'Next.js',
    detectPackages: ['next'],
    adapterPackage: '@holo-js/adapter-next',
    fluxPackage: '@holo-js/flux-react',
    scaffold: {
      dependencies: {
        next: SCAFFOLD_FRAMEWORK_VERSIONS.next,
        react: SCAFFOLD_NEXT_REACT_VERSIONS.react,
        'react-dom': SCAFFOLD_NEXT_REACT_VERSIONS['react-dom'],
        '@holo-js/adapter-next': SCAFFOLD_FRAMEWORK_ADAPTER_VERSIONS.next,
      },
      devDependencies: {
        '@types/react': SCAFFOLD_NEXT_REACT_VERSIONS['@types/react'],
        '@types/react-dom': SCAFFOLD_NEXT_REACT_VERSIONS['@types/react-dom'],
      },
      scripts: {},
      lintScript: 'eslint app config server tests --fix --no-warn-ignored --no-error-on-unmatched-pattern',
      typecheckScript: 'tsc -p tsconfig.json --noEmit',
      defaultUrl: 'http://localhost:3000',
      tsconfig: 'next',
    },
    runner: {
      commandName: 'next',
      buildArgs: ['build'],
      start: ['start'],
      startUsesFrameworkBinary: true,
      preloadNextRuntime: true,
      suppressSvelteKitOutput: false,
      nextDevServerConflictHandling: true,
    },
    capabilities: {
      managedBroadcastAuthRoute: true,
    },
  },
  sveltekit: {
    id: 'sveltekit',
    displayName: 'SvelteKit',
    detectPackages: ['@sveltejs/kit'],
    adapterPackage: '@holo-js/adapter-sveltekit',
    fluxPackage: '@holo-js/flux-svelte',
    scaffold: {
      dependencies: {
        '@holo-js/adapter-sveltekit': SCAFFOLD_FRAMEWORK_ADAPTER_VERSIONS.sveltekit,
        '@sveltejs/adapter-node': SCAFFOLD_SVELTEKIT_DEPENDENCY_VERSIONS['@sveltejs/adapter-node'],
        '@sveltejs/kit': SCAFFOLD_FRAMEWORK_VERSIONS.sveltekit,
        '@sveltejs/vite-plugin-svelte': SCAFFOLD_SVELTEKIT_DEPENDENCY_VERSIONS['@sveltejs/vite-plugin-svelte'],
        svelte: SCAFFOLD_SVELTEKIT_DEPENDENCY_VERSIONS.svelte,
        vite: SCAFFOLD_SVELTEKIT_DEPENDENCY_VERSIONS.vite,
      },
      devDependencies: {
        'svelte-check': SCAFFOLD_SVELTEKIT_DEPENDENCY_VERSIONS['svelte-check'],
      },
      scripts: {},
      lintScript: 'eslint src config server tests --fix --no-warn-ignored --no-error-on-unmatched-pattern',
      typecheckScript: 'svelte-kit sync && svelte-check --tsconfig ./tsconfig.json',
      defaultUrl: 'http://localhost:5173',
      tsconfig: 'sveltekit',
    },
    runner: {
      commandName: 'vite',
      buildArgs: ['build', '--logLevel', 'error'],
      start: ['build/index.js'],
      startUsesFrameworkBinary: false,
      preloadNextRuntime: false,
      suppressSvelteKitOutput: true,
      nextDevServerConflictHandling: false,
    },
    sync: {
      commands: {
        bun: ['bun', 'x', 'svelte-kit', 'sync'],
        npm: ['npm', 'exec', '--', 'svelte-kit', 'sync'],
        pnpm: ['pnpm', 'exec', 'svelte-kit', 'sync'],
        yarn: ['yarn', 'run', 'svelte-kit', 'sync'],
      },
      errorLabel: 'svelte-kit sync',
    },
    capabilities: {
      managedBroadcastAuthRoute: false,
    },
  },
} as const satisfies Record<string, FrameworkDescriptor>

export type SupportedFrameworkId = keyof typeof FRAMEWORK_DESCRIPTORS

export const SUPPORTED_FRAMEWORK_IDS = Object.keys(FRAMEWORK_DESCRIPTORS) as SupportedFrameworkId[]

export function getFrameworkDescriptor(framework: SupportedFrameworkId): FrameworkDescriptor {
  return FRAMEWORK_DESCRIPTORS[framework]
}

export function getFrameworkDescriptorById(framework: string): FrameworkDescriptor | undefined {
  return Object.values(FRAMEWORK_DESCRIPTORS).find(descriptor => descriptor.id === framework)
}

export function isSupportedFrameworkId(framework: string): framework is SupportedFrameworkId {
  return Object.prototype.hasOwnProperty.call(FRAMEWORK_DESCRIPTORS, framework)
}

export function getFrameworkDescriptorByIdFrom(
  framework: string,
  descriptors: readonly FrameworkDescriptor[],
): FrameworkDescriptor | undefined {
  return descriptors.find(descriptor => descriptor.id === framework)
    ?? getFrameworkDescriptorById(framework)
}

export function getFrameworkDescriptors(): readonly FrameworkDescriptor[] {
  return Object.values(FRAMEWORK_DESCRIPTORS)
}

export function getFrameworkDescriptorsWith(
  descriptors: readonly FrameworkDescriptor[],
): readonly FrameworkDescriptor[] {
  return Object.freeze([
    ...descriptors,
    ...Object.values(FRAMEWORK_DESCRIPTORS),
  ])
}

export function detectFrameworkDescriptorFromPackageJson(
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>,
  descriptors: readonly FrameworkDescriptor[] = Object.values(FRAMEWORK_DESCRIPTORS),
): FrameworkDescriptor | undefined {
  return descriptors.find(descriptor =>
    descriptor.detectPackages.some(packageName => dependencies[packageName] || devDependencies[packageName]),
  )
}

export function getFrameworkRuntimeDependencies(framework: SupportedFrameworkId): DependencyMap {
  return SCAFFOLD_FRAMEWORK_RUNTIME_VERSIONS[framework]
}

export function getFrameworkRuntimeDependencyVersion(
  framework: SupportedFrameworkId,
  packageName: string,
): string {
  const version = getFrameworkRuntimeDependencies(framework)[packageName]
  if (!version) {
    throw new Error(`Missing runtime dependency "${packageName}" for framework "${framework}".`)
  }

  return version
}

export function getFrameworkBroadcastPackages(framework: SupportedFrameworkId): readonly `@holo-js/${string}`[] {
  const descriptor = getFrameworkDescriptor(framework)
  return descriptor.fluxPackage
    ? [descriptor.fluxPackage, descriptor.adapterPackage]
    : [descriptor.adapterPackage]
}

export function getFrameworkBroadcastPackagesFromDescriptor(
  descriptor: FrameworkDescriptor,
): readonly `@holo-js/${string}`[] {
  return descriptor.fluxPackage
    ? [descriptor.fluxPackage, descriptor.adapterPackage]
    : [descriptor.adapterPackage]
}

export function frameworkSupportsManagedBroadcastAuthRoute(framework: SupportedFrameworkId | undefined): boolean {
  return framework ? getFrameworkDescriptor(framework).capabilities.managedBroadcastAuthRoute : false
}

export function frameworkDescriptorSupportsManagedBroadcastAuthRoute(framework: FrameworkDescriptor | undefined): boolean {
  return framework?.capabilities.managedBroadcastAuthRoute === true
}

export function getManagedFrameworkPackageNames(): readonly `@holo-js/${string}`[] {
  return Object.values(FRAMEWORK_DESCRIPTORS).flatMap(descriptor => [
    descriptor.adapterPackage,
    ...(descriptor.fluxPackage ? [descriptor.fluxPackage] : []),
  ])
}

type FrameworkSyncDescriptor = {
  readonly framework: SupportedFrameworkId
  readonly commands: FrameworkSyncCommands
  readonly errorLabel: string
}

export function getFrameworkSyncDescriptors(): ReadonlyArray<FrameworkSyncDescriptor> {
  return Object.values(FRAMEWORK_DESCRIPTORS)
    .flatMap((descriptor): FrameworkSyncDescriptor[] => {
      if (!('sync' in descriptor)) {
        return []
      }

      return [{
        framework: descriptor.id as SupportedFrameworkId,
        commands: descriptor.sync.commands,
        errorLabel: descriptor.sync.errorLabel,
      }]
    })
}
