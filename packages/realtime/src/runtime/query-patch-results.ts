export const UNPATCHED_RESULT = Object.freeze({ patched: false } as const)
export const UNCHANGED_ROWS_RESULT = Object.freeze({ patched: true, unchanged: true } as const)
export const UNCHANGED_QUERY_RESULT = Object.freeze({ patched: true, unchanged: true } as const)
