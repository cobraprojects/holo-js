import { HydrationError } from '../core/errors'
import { normalizeDialectReadValue, normalizeDialectWriteValue } from '../schema/normalization'
import type { SchemaDialectName } from '../schema/typeMapping'
import type { TableDefinition } from '../schema/types'
import { Entity } from './Entity'
import { getModelRuntimeSettings } from './runtimeSettings'
import type { BuiltInCastName, ModelCastDefinition, ModelDefinition, ModelRecord } from './types'

type WriteMode = 'create' | 'update'

export class ModelValueTransformer<TTable extends TableDefinition> {
  constructor(
    private readonly definition: ModelDefinition<TTable>,
    private readonly resolveDialect: () => SchemaDialectName,
  ) {}

  resolveAttribute(key: string, entity: Entity<TTable>, value: unknown): unknown {
    const accessor = this.definition.accessors[key]
    return accessor ? accessor(value, entity) : value
  }

  shouldPreventAccessingMissingAttributes(key: string): boolean {
    const settings = getModelRuntimeSettings(this.definition)
    if (!settings.preventAccessingMissingAttributes) {
      return false
    }

    return !Object.prototype.hasOwnProperty.call(this.definition.accessors, key)
  }

  serializeEntity(entity: Entity<TTable>): Record<string, unknown> {
    const serializationEntity = entity as Entity<TTable> & {
      getSerializationConfig?: () => {
        hidden: ReadonlySet<string>
        visible: ReadonlySet<string>
        visibleOnly: readonly string[] | null
        appended: readonly string[] | null
      }
    }
    const config = typeof serializationEntity.getSerializationConfig === 'function'
      ? serializationEntity.getSerializationConfig()
      : null
    const hidden = new Set(this.definition.hidden)
    const visible = new Set(config?.visibleOnly ?? this.definition.visible)

    for (const key of config?.hidden ?? []) {
      hidden.add(key)
    }

    for (const key of config?.visible ?? []) {
      hidden.delete(key)
      visible.add(key)
    }

    const useVisibleAllowlist = visible.size > 0
    const output = Object.fromEntries(
      Object.entries(entity.toAttributes())
        .filter(([key]) => !hidden.has(key) && (!useVisibleAllowlist || visible.has(key)))
        .map(([key]) => [
          key,
          this.serializeAttributeValue(
            key,
            this.resolveAttribute(key, entity, entity.toAttributes()[key as keyof ReturnType<typeof entity.toAttributes>]),
          ),
        ]),
    )

    for (const key of config?.appended ?? this.definition.appended) {
      if (hidden.has(key)) continue
      if (useVisibleAllowlist && !visible.has(key)) continue
      output[key] = this.serializeAttributeValue(
        key,
        this.resolveAttribute(key, entity, entity.toAttributes()[key as keyof ReturnType<typeof entity.toAttributes>]),
      )
    }

    for (const [relationName, relationValue] of Object.entries(entity.getLoadedRelations())) {
      if (hidden.has(relationName)) continue
      if (useVisibleAllowlist && !visible.has(relationName)) continue

      output[relationName] = this.serializeRelationValue(relationValue)
    }

    return output
  }

  private serializeRelationValue(value: unknown): unknown {
    if (value instanceof Entity) {
      return (value as Entity).toJSON()
    }

    if (Array.isArray(value)) {
      return value.map(item => this.serializeRelationValue(item))
    }

    if (value instanceof Date && this.definition.serializeDate) {
      return this.definition.serializeDate(value)
    }

    return value
  }

  private serializeOutputValue(value: unknown): unknown {
    if (value instanceof Date && this.definition.serializeDate) {
      return this.definition.serializeDate(value)
    }

    return value
  }

  serializeAttributeValue(key: string, value: unknown): unknown {
    const builtInCast = this.parseBuiltInCast(this.definition.casts[key])
    if (
      value instanceof Date
      && builtInCast
      && ['date', 'datetime', 'timestamp'].includes(builtInCast.name)
      && builtInCast.parameter
    ) {
      return this.formatDateCast(value, builtInCast.parameter)
    }

    return this.serializeOutputValue(value)
  }

  normalizeFromStorage(
    values: Partial<ModelRecord<TTable>>,
    extraCasts: Record<string, ModelCastDefinition> = {},
  ): Partial<ModelRecord<TTable>> {
    const casts = { ...this.definition.casts, ...extraCasts }
    return Object.fromEntries(
      Object.entries(values).map(([key, value]) => {
        const normalized = this.applySchemaReadNormalization(key, value)
        return [key, this.applyCastGet(casts[key], normalized)]
      }),
    ) as Partial<ModelRecord<TTable>>
  }

  applyTimestampDefaults(
    values: Partial<ModelRecord<TTable>>,
    mode: WriteMode,
  ): Partial<ModelRecord<TTable>> {
    if (!this.definition.timestamps) {
      return values
    }

    const timestamp = new Date().toISOString()
    const nextValues = { ...values }

    if (mode === 'create' && this.definition.createdAtColumn && typeof nextValues[this.definition.createdAtColumn] === 'undefined') {
      nextValues[this.definition.createdAtColumn] = timestamp as never
    }

    if (this.definition.updatedAtColumn && typeof nextValues[this.definition.updatedAtColumn] === 'undefined') {
      nextValues[this.definition.updatedAtColumn] = timestamp as never
    }

    return nextValues
  }

  normalizeForStorage(key: string, value: unknown): unknown {
    const mutator = this.definition.mutators[key]
    const mutated = mutator ? mutator(value) : value
    const casted = this.applyCastSet(this.definition.casts[key], mutated)
    return this.applySchemaWriteNormalization(key, casted)
  }

  private applySchemaReadNormalization(key: string, value: unknown): unknown {
    const column = this.definition.table.columns[key]
    if (!column) {
      return value
    }

    return normalizeDialectReadValue(this.getSchemaDialectName(), column, value)
  }

  private applySchemaWriteNormalization(key: string, value: unknown): unknown {
    const column = this.definition.table.columns[key]
    if (!column) {
      return value
    }

    return normalizeDialectWriteValue(this.getSchemaDialectName(), column, value)
  }

  private getSchemaDialectName(): SchemaDialectName {
    return this.resolveDialect()
  }

  applyCastGet(cast: ModelCastDefinition | undefined, value: unknown): unknown {
    const builtInCast = this.parseBuiltInCast(cast)
    if (builtInCast) {
      switch (builtInCast.name) {
        case 'boolean':
          return value == null ? value : Boolean(value)
        case 'number':
          return value == null ? value : Number(value)
        case 'string':
          return value == null ? value : String(value)
        case 'json':
          return typeof value === 'string' ? JSON.parse(value) : value
        case 'date':
        case 'datetime':
        case 'timestamp':
          return value == null || value instanceof Date ? value : new Date(String(value))
        case 'vector':
          return this.parseVectorValue(value, builtInCast.parameter)
      }
    }

    cast = this.resolveCastDefinition(cast)
    if (typeof cast === 'undefined') return value

    if (typeof cast === 'object' && 'kind' in cast && cast.kind === 'enum') {
      if (value == null) {
        return value
      }

      if (!cast.values.includes(value as string | number)) {
        throw new HydrationError(`Enum cast received unsupported value "${String(value)}".`)
      }

      return value
    }

    return (typeof cast === 'object' && 'get' in cast && cast.get) ? cast.get(value) : value
  }

  private applyCastSet(cast: ModelCastDefinition | undefined, value: unknown): unknown {
    const builtInCast = this.parseBuiltInCast(cast)
    if (builtInCast) {
      switch (builtInCast.name) {
        case 'boolean':
          return value == null ? value : Boolean(value)
        case 'number':
          return value == null ? value : Number(value)
        case 'string':
          return value == null ? value : String(value)
        case 'json':
          return typeof value === 'string' ? value : JSON.stringify(value)
        case 'date':
        case 'datetime':
        case 'timestamp':
          return value instanceof Date ? value.toISOString() : value
        case 'vector':
          return this.serializeVectorValue(value, builtInCast.parameter)
      }
    }

    cast = this.resolveCastDefinition(cast)
    if (typeof cast === 'undefined') return value

    if (typeof cast === 'object' && 'kind' in cast && cast.kind === 'enum') {
      if (value == null) {
        return value
      }

      if (!cast.values.includes(value as string | number)) {
        throw new HydrationError(`Enum cast rejected unsupported value "${String(value)}".`)
      }

      return value
    }

    return (typeof cast === 'object' && 'set' in cast && cast.set) ? cast.set(value) : value
  }

  private resolveCastDefinition(cast: ModelCastDefinition | undefined): Exclude<ModelCastDefinition, { castUsing(): ModelCastDefinition }> | undefined {
    if (!cast) {
      return cast
    }

    if (typeof cast === 'object' && 'castUsing' in cast && typeof cast.castUsing === 'function') {
      return this.resolveCastDefinition(cast.castUsing()) as Exclude<ModelCastDefinition, { castUsing(): ModelCastDefinition }>
    }

    return cast as Exclude<ModelCastDefinition, { castUsing(): ModelCastDefinition }>
  }

  private parseBuiltInCast(
    cast: ModelCastDefinition | undefined,
  ): { name: BuiltInCastName, parameter?: string } | null {
    if (typeof cast !== 'string') {
      return null
    }

    const [rawName, ...rest] = cast.split(':')
    const name = rawName as BuiltInCastName

    const parameter = rest.length > 0 ? rest.join(':').trim() : undefined
    return { name, parameter: parameter || undefined }
  }

  private parseVectorValue(value: unknown, parameter?: string): number[] | null | undefined {
    if (value == null) {
      return value as null | undefined
    }

    const numbers = Array.isArray(value)
      ? value
      : this.parseVectorString(value)

    if (numbers.some(entry => typeof entry !== 'number' || Number.isNaN(entry))) {
      throw new HydrationError('Vector casts require numeric array values.')
    }

    const expectedDimensions = this.parseVectorDimensions(parameter)
    if (expectedDimensions !== null && numbers.length !== expectedDimensions) {
      throw new HydrationError(`Vector cast requires exactly ${expectedDimensions} dimensions.`)
    }

    return [...numbers]
  }

  private serializeVectorValue(value: unknown, parameter?: string): string | null | undefined {
    const parsed = this.parseVectorValue(value, parameter)
    if (parsed == null) {
      return parsed
    }

    return `[${parsed.join(',')}]`
  }

  private parseVectorString(value: unknown): number[] {
    if (typeof value !== 'string') {
      throw new HydrationError('Vector casts require an array or string payload.')
    }

    const trimmed = value.trim()
    if (!trimmed) {
      throw new HydrationError('Vector casts require a non-empty payload.')
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      throw new HydrationError('Vector casts require a JSON array or PostgreSQL-style vector literal.')
    }
    if (!Array.isArray(parsed)) {
      throw new HydrationError('Vector casts require a JSON array or PostgreSQL-style vector literal.')
    }
    return parsed.map(entry => Number(entry))
  }

  private parseVectorDimensions(parameter?: string): number | null {
    if (!parameter) {
      return null
    }

    const dimensions = Number(parameter)
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new HydrationError(`Vector cast parameter "${parameter}" must be a positive integer.`)
    }

    return dimensions
  }

  private formatDateCast(value: Date, parameter: string): number | string {
    if (parameter === 'unix') {
      return Math.floor(value.getTime() / 1000)
    }

    const parts = {
      Y: value.getUTCFullYear().toString().padStart(4, '0'),
      m: String(value.getUTCMonth() + 1).padStart(2, '0'),
      d: String(value.getUTCDate()).padStart(2, '0'),
      H: String(value.getUTCHours()).padStart(2, '0'),
      i: String(value.getUTCMinutes()).padStart(2, '0'),
      s: String(value.getUTCSeconds()).padStart(2, '0'),
    }

    return parameter.replaceAll(/[YmdHis]/g, token => parts[token as keyof typeof parts])
  }
}
