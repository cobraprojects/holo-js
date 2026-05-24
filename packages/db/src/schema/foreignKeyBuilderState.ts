import { inferConstrainedTableName } from './pluralize'
import type { AnyColumnBuilder } from './columns'
import type { ForeignKeyReference } from './types'

export class ForeignKeyBuilderState {
  private referenceTable?: string
  private referenceColumn: string
  private onDeleteAction?: ForeignKeyReference['onDelete']
  private onUpdateAction?: ForeignKeyReference['onUpdate']

  constructor(private readonly columnName: string, referenceColumn = 'id') {
    this.referenceColumn = referenceColumn
  }

  references(columnName: string): void {
    this.referenceColumn = columnName
  }

  on(table: string): void {
    this.referenceTable = table
  }

  constrained(table?: string, columnName = 'id'): void {
    this.referenceTable = table ?? inferConstrainedTableName(this.columnName)
    this.referenceColumn = columnName
  }

  onDelete(action: NonNullable<ForeignKeyReference['onDelete']>): void {
    this.onDeleteAction = action
  }

  onUpdate(action: NonNullable<ForeignKeyReference['onUpdate']>): void {
    this.onUpdateAction = action
  }

  toReference(defaultTable = ''): ForeignKeyReference {
    return {
      table: this.referenceTable ?? defaultTable,
      column: this.referenceColumn,
      onDelete: this.onDeleteAction,
      onUpdate: this.onUpdateAction,
    }
  }

  applyToColumnBuilder(builder: AnyColumnBuilder): AnyColumnBuilder {
    let next = builder.references(this.referenceColumn)
    if (this.referenceTable) {
      next = next.on(this.referenceTable)
    }
    if (this.onDeleteAction) {
      next = next.onDelete(this.onDeleteAction)
    }
    if (this.onUpdateAction) {
      next = next.onUpdate(this.onUpdateAction)
    }
    return next
  }
}
