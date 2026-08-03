import { importOptionalRuntimeModule } from '../runtimeModule'

const featureConfigContributionSpecifiers = [
  '@holo-js/auth/config',
  '@holo-js/broadcast/config',
  '@holo-js/cache/config',
  '@holo-js/mail/config',
  '@holo-js/media/config',
  '@holo-js/notifications/config',
  '@holo-js/queue/config',
  '@holo-js/security/config',
  '@holo-js/session/config',
  '@holo-js/storage/config',
] as const

type FeatureConfigContributionSpecifier = typeof featureConfigContributionSpecifiers[number]

type FeatureConfigContributionLoaders = {
  loadDirect(specifier: FeatureConfigContributionSpecifier, projectRoot: string): Promise<void>
  loadOptional(specifier: FeatureConfigContributionSpecifier, projectRoot: string): Promise<unknown | undefined>
}

async function loadDirectFeatureConfigContribution(specifier: FeatureConfigContributionSpecifier, projectRoot: string): Promise<void> {
  switch (specifier) {
    case '@holo-js/auth/config':
      await import('@holo-js/auth/config')
      break
    case '@holo-js/broadcast/config':
      await import('@holo-js/broadcast/config')
      break
    case '@holo-js/cache/config':
      await import('@holo-js/cache/config')
      break
    case '@holo-js/mail/config':
      await import('@holo-js/mail/config')
      break
    case '@holo-js/media/config':
      await importOptionalRuntimeModule(specifier, { projectRoot })
      break
    case '@holo-js/notifications/config':
      await import('@holo-js/notifications/config')
      break
    case '@holo-js/queue/config':
      await import('@holo-js/queue/config')
      break
    case '@holo-js/security/config':
      await import('@holo-js/security/config')
      break
    case '@holo-js/session/config':
      await import('@holo-js/session/config')
      break
    case '@holo-js/storage/config':
      await import('@holo-js/storage/config')
      break
  }
}

const defaultLoaders: FeatureConfigContributionLoaders = {
  loadDirect: loadDirectFeatureConfigContribution,
  async loadOptional(specifier, projectRoot) {
    return await importOptionalRuntimeModule(specifier, { projectRoot })
  },
}

export async function loadInstalledFeatureConfigContributions(
  projectRoot: string,
  loaders: FeatureConfigContributionLoaders = defaultLoaders,
): Promise<void> {
  for (const specifier of featureConfigContributionSpecifiers) {
    try {
      await loaders.loadDirect(specifier, projectRoot)
    } catch {
      const loaded = await loaders.loadOptional(specifier, projectRoot)
      if (!loaded) continue
    }
  }
}

export const configRuntimeInternals = {
  featureConfigContributionSpecifiers,
}
