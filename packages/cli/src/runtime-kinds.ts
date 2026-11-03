import type { RuntimeCommandKind } from './cli-types'

type SchemaChangingKind = Extract<RuntimeCommandKind, 'migrate' | 'fresh' | 'rollback'>

const SCHEMA_CHANGING_KINDS: ReadonlySet<string> = new Set<SchemaChangingKind>(['migrate', 'fresh', 'rollback'])

export function isSchemaChangingKind(kind: string | undefined): kind is SchemaChangingKind {
  return kind !== undefined && SCHEMA_CHANGING_KINDS.has(kind)
}
