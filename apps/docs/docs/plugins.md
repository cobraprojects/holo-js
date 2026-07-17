# Plugin Authoring

Framework plugins use the contracts in `@holo-js/kernel`. Keep runtime code inside the plugin package and expose only package-relative module paths.

## Package manifest

Install the kernel and declare the plugin entry in `package.json`:

```json
{
  "name": "@acme/holo-audit",
  "type": "module",
  "dependencies": {
    "@holo-js/kernel": "^1.0.0"
  },
  "holo": {
    "plugin": "./dist/plugin.mjs"
  }
}
```

The entry must remain inside the package root. Absolute paths and paths that escape the package are rejected.

## Plugin definition

Import `defineHoloPlugin` from the kernel:

```ts
import { defineHoloPlugin } from '@holo-js/kernel'

export default defineHoloPlugin({
  id: 'acme.audit',
  name: 'Acme Audit',
  contributes: {
    runtime: {
      boot: './dist/runtime/boot.mjs',
    },
  },
})
```

Plugin IDs must be unique. Named contributions within the same contribution family must also be unique. Holo validates definitions and module paths before loading runtime code.

## Feature configuration

A feature package owns its config types, defaults, helper, and normalizer. Register the normalizer from the feature config module and augment `HoloConfigRegistry` so config access remains fully inferred:

```ts
import { registerConfigNormalizer } from '@holo-js/config'

export interface AuditConfig {
  table?: string
}

export interface NormalizedAuditConfig {
  readonly table: string
}

export function defineAuditConfig<TConfig extends AuditConfig>(config: TConfig): Readonly<TConfig> {
  return Object.freeze({ ...config })
}

declare module '@holo-js/config' {
  interface HoloConfigRegistry {
    audit: NormalizedAuditConfig
  }
}

registerConfigNormalizer<AuditConfig, NormalizedAuditConfig>({
  name: 'audit',
  normalize(config) {
    return Object.freeze({
      table: config?.table?.trim() || 'audit_log',
    })
  },
})
```

Applications then import the helper from the feature package:

```ts
import { defineAuditConfig } from '@acme/holo-audit'

export default defineAuditConfig({
  table: 'application_audit_log',
})
```

The generic config loader composes registered normalizers but does not import feature packages. This keeps dependency direction one-way and lets optional features remain optional.

## Application activation

Add the package name to `config/app.ts`:

```ts
import { defineAppConfig } from '@holo-js/config'

export default defineAppConfig({
  plugins: ['@acme/holo-audit'],
})
```

Run `holo prepare` after installing or changing a plugin so generated registries and framework artifacts match the active contribution set.
