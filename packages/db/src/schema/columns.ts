import { SchemaError } from '../core/errors'
import { assertValidIdentifierPath, assertValidIdentifierSegment } from './identifiers'
import { inferConstrainedTableName } from './pluralize'
import type {
  AnyColumnDefinition,
  ColumnDefaultKind,
  ColumnDefinition,
  ForeignKeyReference,
  IdGenerationStrategy,
  LogicalColumnKind,
  VectorValue,
} from './types'

type ColumnMetadata = {
  kind: LogicalColumnKind
  name?: string
  nullable: boolean
  hasDefault: boolean
  generated: boolean
  primaryKey: boolean
  unique: boolean
  defaultKind?: ColumnDefaultKind
  defaultValue?: unknown
  references?: ForeignKeyReference
  referenceTable?: string
  inferReferenceTable?: boolean
  referenceColumn?: string
  referenceConstraintName?: string
  referenceOnDelete?: ForeignKeyReference['onDelete']
  referenceOnUpdate?: ForeignKeyReference['onUpdate']
  idStrategy?: IdGenerationStrategy
  enumValues?: readonly string[]
  vectorDimensions?: number
}

type VectorOptions = {
  dimensions: number
}

type ColumnBuildOptions = {
  name: string
}

export class ColumnBuilder<
  TType,
  TNullable extends boolean = false,
  THasDefault extends boolean = false,
  TGenerated extends boolean = false,
> {
  private readonly metadata: ColumnMetadata

  constructor(kind: LogicalColumnKind, name?: string, metadata?: Partial<ColumnMetadata>) {
    this.metadata = {
      kind,
      name,
      nullable: false,
      hasDefault: false,
      generated: false,
      primaryKey: false,
      unique: false,
      ...metadata,
    }
  }

  notNull(): ColumnBuilder<TType, false, THasDefault, TGenerated> {
    return this.clone({ nullable: false })
  }

  nullable(): ColumnBuilder<TType, true, THasDefault, TGenerated> {
    return this.clone({ nullable: true })
  }

  default(value: unknown): ColumnBuilder<TType, TNullable, true, TGenerated> {
    return this.clone({
      hasDefault: true,
      defaultKind: 'value',
      defaultValue: value,
    })
  }

  defaultNow(): ColumnBuilder<TType, TNullable, true, TGenerated> {
    return this.clone({
      hasDefault: true,
      defaultKind: 'now',
      defaultValue: undefined,
    })
  }

  generated(): ColumnBuilder<TType, TNullable, THasDefault, true> {
    return this.clone({ generated: true })
  }

  primaryKey(): ColumnBuilder<TType, TNullable, THasDefault, TGenerated> {
    return this.clone({ primaryKey: true })
  }

  unique(): ColumnBuilder<TType, TNullable, THasDefault, TGenerated> {
    return this.clone({ unique: true })
  }

  references(columnName: string): ColumnBuilder<TType, TNullable, THasDefault, TGenerated> {
    assertValidIdentifierSegment(columnName, 'Foreign key column')

    return this.clone({
      referenceColumn: columnName,
    })
  }

  on(table: string): ColumnBuilder<TType, TNullable, THasDefault, TGenerated> {
    assertValidIdentifierPath(table, 'Foreign key table')

    return this.clone({
      referenceTable: table,
      inferReferenceTable: false,
    })
  }

  constraintName(name: string): ColumnBuilder<TType, TNullable, THasDefault, TGenerated> {
    assertValidIdentifierSegment(name, 'Foreign key name')

    return this.clone({
      referenceConstraintName: name,
    })
  }

  constrained(
    table?: string,
    columnName = 'id',
  ): ColumnBuilder<TType, TNullable, THasDefault, TGenerated> {
    if (table) {
      assertValidIdentifierPath(table, 'Foreign key table')
    }
    assertValidIdentifierSegment(columnName, 'Foreign key column')

    return this.clone({
      referenceTable: table,
      inferReferenceTable: typeof table === 'undefined',
      referenceColumn: columnName,
    })
  }

  onDelete(action: NonNullable<ForeignKeyReference['onDelete']>): ColumnBuilder<TType, TNullable, THasDefault, TGenerated> {
    return this.clone({
      referenceOnDelete: action,
    })
  }

  onUpdate(action: NonNullable<ForeignKeyReference['onUpdate']>): ColumnBuilder<TType, TNullable, THasDefault, TGenerated> {
    return this.clone({
      referenceOnUpdate: action,
    })
  }

  cascadeOnDelete(): ColumnBuilder<TType, TNullable, THasDefault, TGenerated> {
    return this.onDelete('cascade')
  }

  restrictOnDelete(): ColumnBuilder<TType, TNullable, THasDefault, TGenerated> {
    return this.onDelete('restrict')
  }

  nullOnDelete(): ColumnBuilder<TType, TNullable, THasDefault, TGenerated> {
    return this.onDelete('set null')
  }

  noActionOnDelete(): ColumnBuilder<TType, TNullable, THasDefault, TGenerated> {
    return this.onDelete('no action')
  }

  cascadeOnUpdate(): ColumnBuilder<TType, TNullable, THasDefault, TGenerated> {
    return this.onUpdate('cascade')
  }

  restrictOnUpdate(): ColumnBuilder<TType, TNullable, THasDefault, TGenerated> {
    return this.onUpdate('restrict')
  }

  nullOnUpdate(): ColumnBuilder<TType, TNullable, THasDefault, TGenerated> {
    return this.onUpdate('set null')
  }

  noActionOnUpdate(): ColumnBuilder<TType, TNullable, THasDefault, TGenerated> {
    return this.onUpdate('no action')
  }

  toDefinition(options: ColumnBuildOptions): ColumnDefinition<TType, TNullable, THasDefault, TGenerated> {
    assertValidIdentifierSegment(options.name, 'Column name')

    const resolvedName = this.metadata.name ?? options.name
    if (resolvedName !== options.name) {
      throw new SchemaError(
        `Column "${options.name}" cannot redefine its name as "${resolvedName}". Declare one canonical column name only.`,
      )
    }

    assertValidIdentifierSegment(resolvedName, 'Column name')
    const resolvedReferenceTable = this.metadata.referenceTable
      ?? (this.metadata.inferReferenceTable ? inferConstrainedTableName(resolvedName) : undefined)
    const resolvedReferenceColumn = this.metadata.referenceColumn
    if (resolvedReferenceColumn && !resolvedReferenceTable) {
      throw new SchemaError(
        `Column "${resolvedName}" defines a foreign key column "${resolvedReferenceColumn}" but no foreign key table. Call .on(...) or .constrained(...).`,
      )
    }

    return Object.freeze({
      kind: this.metadata.kind,
      name: resolvedName,
      nullable: this.metadata.nullable as TNullable,
      hasDefault: this.metadata.hasDefault as THasDefault,
      generated: this.metadata.generated as TGenerated,
      primaryKey: this.metadata.primaryKey,
      unique: this.metadata.unique,
      defaultKind: this.metadata.defaultKind,
      defaultValue: this.metadata.defaultValue,
      references: resolvedReferenceTable && resolvedReferenceColumn
        ? {
            table: resolvedReferenceTable,
            column: resolvedReferenceColumn,
            constraintName: this.metadata.referenceConstraintName,
            onDelete: this.metadata.referenceOnDelete,
            onUpdate: this.metadata.referenceOnUpdate,
          }
        : undefined,
      idStrategy: this.metadata.idStrategy,
      enumValues: this.metadata.enumValues,
      vectorDimensions: this.metadata.vectorDimensions,
    })
  }

  private clone<TNextNullable extends boolean = TNullable, TNextHasDefault extends boolean = THasDefault, TNextGenerated extends boolean = TGenerated>(
    metadata: Partial<ColumnMetadata>,
  ): ColumnBuilder<TType, TNextNullable, TNextHasDefault, TNextGenerated> {
    return new ColumnBuilder<TType, TNextNullable, TNextHasDefault, TNextGenerated>(
      this.metadata.kind,
      metadata.name ?? this.metadata.name,
      {
        ...this.metadata,
        ...metadata,
      },
    )
  }
}

function scalar<
  TType,
  TNullable extends boolean = false,
  THasDefault extends boolean = false,
  TGenerated extends boolean = false,
>(
  kind: LogicalColumnKind,
  name?: string,
  metadata?: Partial<ColumnMetadata>,
): ColumnBuilder<TType, TNullable, THasDefault, TGenerated> {
  return new ColumnBuilder<TType, TNullable, THasDefault, TGenerated>(kind, name, metadata)
}

export const column = {
  id(name?: string) {
    return scalar<number, false, false, true>('id', name, {
      idStrategy: 'autoIncrement',
      primaryKey: true,
      generated: true,
    })
  },
  autoIncrementId(name?: string) {
    return scalar<number, false, false, true>('id', name, {
      idStrategy: 'autoIncrement',
      primaryKey: true,
      generated: true,
    })
  },
  integer(name?: string) {
    return scalar<number>('integer', name)
  },
  bigInteger(name?: string) {
    return scalar<number>('bigInteger', name)
  },
  string(name?: string) {
    return scalar<string>('string', name)
  },
  text(name?: string) {
    return scalar<string>('text', name)
  },
  boolean(name?: string) {
    return scalar<boolean>('boolean', name)
  },
  real(name?: string) {
    return scalar<number>('real', name)
  },
  decimal(name?: string) {
    return scalar<string>('decimal', name)
  },
  date(name?: string) {
    return scalar<Date>('date', name)
  },
  datetime(name?: string) {
    return scalar<Date>('datetime', name)
  },
  timestamp(name?: string) {
    return scalar<Date>('timestamp', name)
  },
  json<TValue = unknown>(name?: string) {
    return scalar<TValue>('json', name)
  },
  blob(name?: string) {
    return scalar<Uint8Array>('blob', name)
  },
  uuid(name?: string) {
    return scalar<string>('uuid', name)
  },
  ulid(name?: string) {
    return scalar<string>('ulid', name)
  },
  snowflake(name?: string) {
    return scalar<string>('snowflake', name, { idStrategy: 'snowflake' })
  },
  foreignId(name?: string) {
    return scalar<number>('bigInteger', name)
  },
  foreignUuid(name?: string) {
    return scalar<string>('uuid', name)
  },
  foreignUlid(name?: string) {
    return scalar<string>('ulid', name)
  },
  foreignSnowflake(name?: string) {
    return scalar<string>('snowflake', name, { idStrategy: 'snowflake' })
  },
  vector(options: VectorOptions, name?: string) {
    return scalar<VectorValue>('vector', name, {
      vectorDimensions: options.dimensions,
    })
  },
  enum<const TValues extends readonly string[]>(values: TValues, name?: string) {
    return scalar<TValues[number]>('enum', name, {
      enumValues: values,
    })
  },
}

export type AnyColumnBuilder = ColumnBuilder<unknown, boolean, boolean, boolean>
export type ColumnInput = AnyColumnBuilder | AnyColumnDefinition

export function isColumnBuilder(value: ColumnInput): value is AnyColumnBuilder {
  return 'toDefinition' in value && typeof value.toDefinition === 'function'
}
