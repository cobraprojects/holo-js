import { describe, expect, it } from 'vitest'
import { NO_EXACT_ID_PREDICATE } from '../src/runtime/predicate-matching'
import { exactIdsDiffer, matchesExactRowIdentity, matchesPatchedExactRowIdentity, rowIdentityIndexMayHold, rowsContainExactId } from '../src/runtime/query-row-matching'

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

  it('treats a boolean key as possibly the one or zero a database stores for it', () => {
    expect(exactIdsDiffer(true, 1)).toBe(false)
    expect(exactIdsDiffer(false, '0')).toBe(false)
    expect(rowIdentityIndexMayHold(new Map([[true, 0]]), 1)).toBe(true)
    expect(rowIdentityIndexMayHold(new Map([[false, 0]]), '0')).toBe(true)
    expect(matchesExactRowIdentity({ active: true }, 1n, 'active')).toBe(true)
    expect(matchesPatchedExactRowIdentity({ active: false }, { active: true }, 1n, 'active')).toBe(true)
  })

  it('matches equal number and BigInt keys and treats unsafe integer keys as possibly equal', () => {
    expect(exactIdsDiffer(1, 1n)).toBe(false)
    expect(exactIdsDiffer(1, 2n)).toBe(true)
    expect(exactIdsDiffer(1000000000000000100, 1000000000000000100n)).toBe(false)
    expect(exactIdsDiffer(9007199254740993n, 9007199254740992n)).toBe(false)
    expect(rowIdentityIndexMayHold(new Map([[1000000000000000100, 0]]), 1000000000000000100n)).toBe(true)
  })
})
