import { expectTypeOf, it } from 'vitest'
import { defineModel } from '../src'

const PageView = defineModel('page_views_on_analytics', { connectionName: 'analytics', fillable: ['path'] })

type PageViewEntity = Awaited<ReturnType<typeof PageView.findOrFail>>

it('types a model without a Generated-schema table as a loose record of driver values', () => {
  expectTypeOf<ReturnType<PageViewEntity['toJSON']>>().toEqualTypeOf<Record<string, unknown>>()
  expectTypeOf<PageViewEntity['path']>().toEqualTypeOf<unknown>()
  expectTypeOf<{ path: string, hits: number }>().toExtend<Parameters<typeof PageView.create>[0]>()
})
