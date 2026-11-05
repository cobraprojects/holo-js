import { describe, expect, it } from 'vitest'
import { NO_EXACT_ID_PREDICATE } from '../src/runtime/predicate-matching'
import { matchesExactRowIdentity, matchesPatchedExactRowIdentity, rowsContainExactId } from '../src/runtime/query-row-matching'

describe('@holo-js/realtime row key matching', () => {
  it('matches equal keys and leaves differently spelled string keys undecided', () => {
    expect(matchesExactRowIdentity({ code: 'DE' }, 'DE', 'code')).toBe(true)
    expect(matchesExactRowIdentity({ code: 'de' }, 'DE', 'code')).toBeUndefined()
    expect(matchesExactRowIdentity({ id: 2 }, 1, 'id')).toBe(false)
    expect(matchesExactRowIdentity({ name: 'Germany' }, 'DE', 'code')).toBeUndefined()
    expect(matchesPatchedExactRowIdentity({ code: 'DE' }, { code: 'de' }, 'DE', 'code')).toBeUndefined()
    expect(matchesPatchedExactRowIdentity({ code: 'DE' }, { name: 'Deutschland' }, 'DE', 'code')).toBe(true)
    expect(rowsContainExactId([{ code: 'FR' }, { code: 'de' }], 'DE', 'code')).toBeUndefined()
    expect(rowsContainExactId([{ code: 'DE' }], NO_EXACT_ID_PREDICATE, 'code')).toBeUndefined()
  })
})
