import { SecurityError } from '../core/errors'
import { normalizePaginationParameterName } from './pagination'
import type {
  CursorPaginatedResult,
  PaginationMeta,
  PaginatedResult,
  SimplePaginatedResult,
  SimplePaginationMeta,
} from './types'

export function createPaginator<T>(
  data: readonly T[],
  meta: Omit<PaginationMeta, 'pageName'> & { pageName?: string },
): PaginatedResult<T> {
  const result = {
    data,
    meta: {
      ...meta,
      pageName: normalizePaginationParameterName(meta.pageName, 'page', message => new SecurityError(message)),
    },
  } as PaginatedResult<T>

  attachMethods(result, {
    items: () => result.data,
    firstItem: () => result.meta.from,
    lastItem: () => result.meta.to,
    hasPages: () => result.meta.lastPage > 1,
    hasMorePages: () => result.meta.hasMorePages,
    getPageName: () => result.meta.pageName,
    toJSON: () => ({
      data: result.data,
      meta: result.meta,
    }),
  })

  return result
}

export function createSimplePaginator<T>(
  data: readonly T[],
  meta: Omit<SimplePaginationMeta, 'pageName'> & { pageName?: string },
): SimplePaginatedResult<T> {
  const result = {
    data,
    meta: {
      ...meta,
      pageName: normalizePaginationParameterName(meta.pageName, 'page', message => new SecurityError(message)),
    },
  } as SimplePaginatedResult<T>

  attachMethods(result, {
    items: () => result.data,
    firstItem: () => result.meta.from,
    lastItem: () => result.meta.to,
    hasPages: () => result.meta.currentPage > 1 || result.meta.hasMorePages,
    hasMorePages: () => result.meta.hasMorePages,
    getPageName: () => result.meta.pageName,
    toJSON: () => ({
      data: result.data,
      meta: result.meta,
    }),
  })

  return result
}

export function createCursorPaginator<T>(
  data: readonly T[],
  meta: { perPage: number, nextCursor: string | null, prevCursor: string | null, cursorName?: string },
): CursorPaginatedResult<T> {
  const result = {
    data,
    perPage: meta.perPage,
    cursorName: normalizePaginationParameterName(meta.cursorName, 'cursor', message => new SecurityError(message)),
    nextCursor: meta.nextCursor,
    prevCursor: meta.prevCursor,
  } as CursorPaginatedResult<T>

  attachMethods(result, {
    items: () => result.data,
    hasMorePages: () => result.nextCursor !== null,
    getCursorName: () => result.cursorName,
    nextCursorToken: () => result.nextCursor,
    previousCursorToken: () => result.prevCursor,
    toJSON: () => ({
      data: result.data,
      perPage: result.perPage,
      cursorName: result.cursorName,
      nextCursor: result.nextCursor,
      prevCursor: result.prevCursor,
    }),
  })

  return result
}

function attachMethods<T extends object>(
  target: T,
  methods: Record<string, () => unknown>,
): void {
  Object.defineProperties(
    target,
    Object.fromEntries(
      Object.entries(methods).map(([key, value]) => [
        key,
        {
          value,
          enumerable: false,
          configurable: true,
          writable: true,
        },
      ]),
    ),
  )
}
