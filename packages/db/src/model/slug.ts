import type { TableDefinition } from '../schema/types'
import type { ModelAttributeKey, ModelColumnName, ModelRecord, ModelScopesDefinition, RelationMap } from './types'

type StringModelAttributeKey<TTable extends TableDefinition> = Extract<{
  [K in ModelAttributeKey<TTable>]: Exclude<ModelRecord<TTable>[K], null | undefined> extends string ? K : never
}[ModelAttributeKey<TTable>], string>

type PrimaryKeyName<TTable extends TableDefinition> = Extract<{
  [K in keyof TTable['columns']]: TTable['columns'][K] extends { readonly primaryKey: true } ? K : never
}[keyof TTable['columns']], keyof ModelRecord<TTable> & string>

type ModelPrimaryKeyValue<TTable extends TableDefinition>
  = [PrimaryKeyName<TTable>] extends [never]
    ? ModelRecord<TTable>[ModelAttributeKey<TTable>]
    : ModelRecord<TTable>[PrimaryKeyName<TTable>]

export interface UniqueSlugOptions<
  TTable extends TableDefinition,
  TColumn extends StringModelAttributeKey<TTable> = StringModelAttributeKey<TTable>,
> {
  readonly column?: TColumn
  readonly ignore?: ModelPrimaryKeyValue<TTable>
  readonly separator?: string
  readonly fallback?: string
}

type UniqueSlugModel<
  TTable extends TableDefinition,
  _TScopes extends ModelScopesDefinition,
  _TRelations extends RelationMap,
> = {
  readonly definition: {
    readonly connectionName?: string
    readonly name: string
    readonly primaryKey: string
  }
  whereLike(column: ModelColumnName<TTable>, value: string): {
    when(
      condition: boolean,
      callback: (query: {
        where(column: string, operator: string, value: unknown): unknown
      }) => unknown,
    ): {
      pluck<TColumn extends ModelAttributeKey<TTable>>(column: TColumn): Promise<Array<ModelRecord<TTable>[TColumn]>>
    }
  }
}

const reservedSlugs = new Map<string, Set<string>>()
const slugReservationQueues = new Map<string, Promise<void>>()

function slugify(value: string, separator: string, fallback: string): string {
  const normalized = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`^${escapeRegExp(separator)}+|${escapeRegExp(separator)}+$`, 'g'), '')

  return normalized || fallback
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function reserveNextSlug<TResult>(key: string, callback: () => Promise<TResult>): Promise<TResult> {
  const previous = slugReservationQueues.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = previous.then(() => new Promise<void>((resolve) => {
    release = resolve
  }))
  slugReservationQueues.set(key, current)

  await previous

  try {
    return await callback()
  } finally {
    release()
    if (slugReservationQueues.get(key) === current) {
      slugReservationQueues.delete(key)
    }
  }
}

export async function uniqueSlug<
  TTable extends TableDefinition,
  TScopes extends ModelScopesDefinition,
  TRelations extends RelationMap,
  TColumn extends StringModelAttributeKey<TTable> = Extract<'slug', StringModelAttributeKey<TTable>>,
>(
  model: UniqueSlugModel<TTable, TScopes, TRelations>,
  value: string,
  options: UniqueSlugOptions<TTable, TColumn> = {},
): Promise<string> {
  const column = (options.column ?? 'slug') as TColumn
  const separator = options.separator ?? '-'
  const fallback = options.fallback ?? 'entry'
  const base = slugify(value, separator, fallback)
  const key = `${model.definition.connectionName ?? 'default'}:${model.definition.name}:${column}:${base}`

  return await reserveNextSlug(key, async () => {
    const query = model
      .whereLike(column as ModelColumnName<TTable>, `${base}%`)
      .when(typeof options.ignore !== 'undefined', builder => builder.where(model.definition.primaryKey, '!=', options.ignore))
    const existing = await query.pluck(column)
    const reserved = reservedSlugs.get(key) ?? new Set<string>()
    const taken = new Set<string>(reserved)
    for (const slug of existing as readonly string[]) {
      taken.add(slug)
    }

    for (let index = 1; ; index += 1) {
      const candidate = index === 1 ? base : `${base}${separator}${index}`
      if (!taken.has(candidate)) {
        reserved.add(candidate)
        reservedSlugs.set(key, reserved)
        return candidate
      }
    }
  })
}
