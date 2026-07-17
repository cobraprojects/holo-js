export type OptionalFeatureImporter = <TModule>(
  specifier: string,
  options?: { readonly projectRoot?: string },
) => Promise<TModule | undefined>

export interface OptionalFeatureModuleLoader<TModule> {
  (required: true, options?: { readonly projectRoot?: string }): Promise<TModule>
  (required?: false, options?: { readonly projectRoot?: string }): Promise<TModule | undefined>
  (required: boolean, options?: { readonly projectRoot?: string }): Promise<TModule | undefined>
}

export function createOptionalFeatureModuleLoader<TModule>(
  importer: OptionalFeatureImporter,
  specifier: string,
  missingPackageMessage: string,
): OptionalFeatureModuleLoader<TModule> {
  async function load(
    required = false,
    options: { readonly projectRoot?: string } = {},
  ): Promise<TModule | undefined> {
    const module = await importer<TModule>(specifier, options)
    if (!module && required) throw new Error(missingPackageMessage)
    return module
  }

  return load as OptionalFeatureModuleLoader<TModule>
}
