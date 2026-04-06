/* v8 ignore file -- type declarations only */
export interface PaginationMeta {
  readonly total: number
  readonly perPage: number
  readonly pageName: string
  readonly currentPage: number
  readonly lastPage: number
  readonly from: number | null
  readonly to: number | null
  readonly hasMorePages: boolean
}

export interface PaginatorMethods<T> {
  items(): readonly T[]
  firstItem(): number | null
  lastItem(): number | null
  hasPages(): boolean
  hasMorePages(): boolean
  getPageName(): string
  toJSON(): { data: readonly T[], meta: PaginationMeta }
}

export interface SimplePaginationMeta {
  readonly perPage: number
  readonly pageName: string
  readonly currentPage: number
  readonly from: number | null
  readonly to: number | null
  readonly hasMorePages: boolean
}

export interface SimplePaginatorMethods<T> {
  items(): readonly T[]
  firstItem(): number | null
  lastItem(): number | null
  hasPages(): boolean
  hasMorePages(): boolean
  getPageName(): string
  toJSON(): { data: readonly T[], meta: SimplePaginationMeta }
}

export interface PaginatedResult<T> extends PaginatorMethods<T> {
  readonly data: readonly T[]
  readonly meta: PaginationMeta
}

export interface SimplePaginatedResult<T> extends SimplePaginatorMethods<T> {
  readonly data: readonly T[]
  readonly meta: SimplePaginationMeta
}

export interface CursorPaginatorMethods<T> {
  items(): readonly T[]
  hasMorePages(): boolean
  getCursorName(): string
  nextCursorToken(): string | null
  previousCursorToken(): string | null
  toJSON(): {
    data: readonly T[]
    perPage: number
    cursorName: string
    nextCursor: string | null
    prevCursor: string | null
  }
}

export interface CursorPaginatedResult<T> extends CursorPaginatorMethods<T> {
  readonly data: readonly T[]
  readonly perPage: number
  readonly cursorName: string
  readonly nextCursor: string | null
  readonly prevCursor: string | null
}

export interface PaginationOptions {
  readonly pageName?: string
}

export interface CursorPaginationOptions {
  readonly cursorName?: string
}
