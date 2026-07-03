import { describe, expect, it } from 'vitest'
import {
  collectTableDependencies,
  parseDatabaseDependency,
  parseInvalidationEvent,
  parsePredicateDependency,
} from '../src/runtime/dependencies'

function encodeDependencyValue(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value))
}

describe('@holo-js/realtime dependency parsing', () => {
  it('rejects malformed database and predicate dependency strings', () => {
    expect(parseDatabaseDependency('posts')).toBeUndefined()
    expect(parseDatabaseDependency('db:')).toBeUndefined()
    expect(parseDatabaseDependency('db:main:')).toBeUndefined()
    expect(parseDatabaseDependency('db:main::where:id:1')).toBeUndefined()
    expect(parseDatabaseDependency('db:main:posts:')).toEqual({
      suffix: '',
      tableKey: 'db:main:posts',
    })
    expect(parsePredicateDependency('db:main:posts:where::1')).toBeUndefined()
    expect(parsePredicateDependency('db:main:posts:where:id:')).toBeUndefined()
  })

  it('deduplicates table dependencies while preserving distinct table order', () => {
    expect(collectTableDependencies([
      'db:main:posts',
      'db:main:posts',
      'db:main:comments',
    ])).toEqual([
      'db:main:posts',
      'db:main:comments',
    ])
  })

  it('parses non-database and mutation invalidation dependencies as direct dependencies', () => {
    const status = encodeDependencyValue('open')
    const parsed = parseInvalidationEvent({
      connectionName: 'main',
      dependencies: [
        'cache:posts',
        'db:main:posts:mutation',
        `db:main:posts:where:status:${status}`,
      ],
    })

    expect(parsed.directDependencies).toEqual([
      'cache:posts',
      'db:main:posts:mutation',
      `db:main:posts:where:status:${status}`,
    ])
    expect(parsed.hasMutationDependency).toBe(true)
    expect(parsed.predicates.get('db:main:posts')?.get('status')?.has(status)).toBe(true)
  })
})
