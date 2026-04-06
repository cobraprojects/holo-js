declare module '@nuxt/kit' {
  export function defineNuxtModule<TOptions = Record<string, never>>(definition: {
    meta?: { name?: string }
    defaults?: Partial<TOptions>
    setup?: (options: TOptions, nuxt: unknown) => void | Promise<void>
  }): {
    meta?: { name?: string }
    defaults?: Partial<TOptions>
    setup: (options: TOptions, nuxt: unknown) => void | Promise<void>
  }

  export function createResolver(base: string): {
    resolve(value: string): string
  }

  export function addImports(imports: Array<{ name: string, as?: string, from: string }>): void
  export function addServerPlugin(path: string): void
  export function addServerImportsDir(path: string): void
  export function addServerHandler(input: { route: string, handler: string }): void
}
