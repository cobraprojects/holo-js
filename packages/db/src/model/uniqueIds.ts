import { monotonicFactory } from 'ulid'
import { v7 as uuidv7 } from 'uuid'
import { SchemaError } from '../core/errors'
import type { TableDefinition } from '../schema/types'
import type {
  ModelAttributeKey,
  ModelTrait,
  UniqueIdRuntimeConfig,
  UniqueIdTrait,
} from './types'

export interface UniqueIdTraitOptions<TTable extends TableDefinition = TableDefinition> {
  columns?: readonly ModelAttributeKey<TTable>[]
  generator?: () => string
}

const monotonicUlid = monotonicFactory()
let lastSnowflakeTimestamp = 0n
let lastSnowflakeSequence = 0n
const SNOWFLAKE_EPOCH = 1704067200000n
const SNOWFLAKE_NODE_ID = 1n
const SNOWFLAKE_SEQUENCE_MASK = 0xFFFn

export function generateUuidV7(): string {
  return uuidv7()
}

export function generateUlid(): string {
  return monotonicUlid()
}

export function generateSnowflake(): string {
  let timestamp = BigInt(Date.now()) - SNOWFLAKE_EPOCH

  if (timestamp < lastSnowflakeTimestamp) {
    timestamp = lastSnowflakeTimestamp
  }

  if (timestamp === lastSnowflakeTimestamp) {
    lastSnowflakeSequence = (lastSnowflakeSequence + 1n) & SNOWFLAKE_SEQUENCE_MASK
    if (lastSnowflakeSequence === 0n) {
      timestamp = lastSnowflakeTimestamp + 1n
    }
  } else {
    lastSnowflakeSequence = 0n
  }

  lastSnowflakeTimestamp = timestamp
  return ((timestamp << 22n) | (SNOWFLAKE_NODE_ID << 12n) | lastSnowflakeSequence).toString()
}

export function HasUniqueIds<TTable extends TableDefinition = TableDefinition>(
  options: UniqueIdTraitOptions<TTable> = {},
): UniqueIdTrait<TTable> {
  return {
    kind: 'uniqueIds',
    name: 'HasUniqueIds',
    type: 'custom',
    columns: options.columns,
    generator: options.generator,
  }
}

export function HasUuids<TTable extends TableDefinition = TableDefinition>(
  options: Omit<UniqueIdTraitOptions<TTable>, 'generator'> = {},
): UniqueIdTrait<TTable> {
  return {
    kind: 'uniqueIds',
    name: 'HasUuids',
    type: 'uuid',
    columns: options.columns,
    generator: generateUuidV7,
  }
}

export function HasUlids<TTable extends TableDefinition = TableDefinition>(
  options: Omit<UniqueIdTraitOptions<TTable>, 'generator'> = {},
): UniqueIdTrait<TTable> {
  return {
    kind: 'uniqueIds',
    name: 'HasUlids',
    type: 'ulid',
    columns: options.columns,
    generator: generateUlid,
  }
}

export function HasSnowflakes<TTable extends TableDefinition = TableDefinition>(
  options: Omit<UniqueIdTraitOptions<TTable>, 'generator'> = {},
): UniqueIdTrait<TTable> {
  return {
    kind: 'uniqueIds',
    name: 'HasSnowflakes',
    type: 'snowflake',
    columns: options.columns,
    generator: generateSnowflake,
  }
}

function isUniqueIdTrait<TTable extends TableDefinition>(
  trait: ModelTrait<TTable>,
): trait is UniqueIdTrait<TTable> {
  return trait.kind === 'uniqueIds'
}

export function resolveUniqueIdConfig<TTable extends TableDefinition>(
  traits: readonly ModelTrait<TTable>[] | undefined,
  primaryKey: ModelAttributeKey<TTable>,
  uniqueIds?: readonly ModelAttributeKey<TTable>[],
  newUniqueId?: () => string,
): UniqueIdRuntimeConfig<TTable> | null {
  const uniqueIdTraits = (traits ?? []).filter(isUniqueIdTrait)

  if (uniqueIdTraits.length > 1) {
    throw new SchemaError('Only one unique ID trait may be applied to a model.')
  }

  if (uniqueIdTraits.length === 0) {
    if (uniqueIds || newUniqueId) {
      throw new SchemaError('uniqueIds and newUniqueId require a unique ID trait.')
    }
    return null
  }

  const trait = uniqueIdTraits[0]!
  const columns = uniqueIds ?? trait.columns ?? [primaryKey]
  if (columns.length === 0) {
    throw new SchemaError('uniqueIds must contain at least one column.')
  }

  const generator = newUniqueId ?? trait.generator
  if (trait.type === 'custom' && !generator) {
    throw new SchemaError('HasUniqueIds requires an explicit generator.')
  }

  return {
    usesUniqueIds: true,
    columns: [...new Set(columns)] as readonly ModelAttributeKey<TTable>[],
    generator: generator ?? generateUuidV7,
    traitName: trait.name,
    traitType: trait.type,
  }
}

const STRING_LIKE_KINDS = new Set(['string', 'text', 'uuid', 'ulid', 'snowflake'])

export function validateUniqueIdConfig<TTable extends TableDefinition>(
  table: TTable,
  _modelName: string,
  config: UniqueIdRuntimeConfig<TTable> | null,
): void {
  if (!config) return

  for (const columnName of config.columns) {
    const column = table.columns[columnName]
    if (!column) {
      throw new SchemaError(`Unique ID column "${String(columnName)}" does not exist on table "${table.tableName}".`)
    }

    if (!STRING_LIKE_KINDS.has(column.kind)) {
      throw new SchemaError(`Unique ID column "${String(columnName)}" on table "${table.tableName}" must be string-like.`)
    }

    if (config.traitType === 'uuid' && column.kind === 'ulid') {
      throw new SchemaError(`HasUuids cannot target ULID column "${String(columnName)}" on table "${table.tableName}".`)
    }

    if (config.traitType === 'ulid' && column.kind === 'uuid') {
      throw new SchemaError(`HasUlids cannot target UUID column "${String(columnName)}" on table "${table.tableName}".`)
    }

    if (config.traitType === 'snowflake' && !['snowflake', 'string', 'text'].includes(column.kind)) {
      throw new SchemaError(`HasSnowflakes cannot target ${column.kind} column "${String(columnName)}" on table "${table.tableName}".`)
    }

    if (!column.primaryKey && !column.unique) {
      throw new SchemaError(`Unique ID column "${String(columnName)}" on table "${table.tableName}" must be primary or unique.`)
    }
  }
}
