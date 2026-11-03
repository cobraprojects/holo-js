import { expectTypeOf, it } from 'vitest'
import { belongsToMany, column, defineGeneratedTable, defineModel, type GeneratedSchemaTable, type InferSelect, type ModelCastedTable } from '../src'
import type {} from './fixtures/legacy-sqlite-dates/sqlite.generated'

type Attributes<TModel extends { findOrFail(id: number): Promise<object> }> = Awaited<ReturnType<TModel['findOrFail']>>
type Flat<TValue> = { [K in keyof TValue]: TValue[K] }
type InsertPayload<TModel extends { create(...args: never[]): unknown }> = Flat<Parameters<TModel['create']>[0]>
type UpdatePayload<TModel extends { update(...args: never[]): unknown }> = Parameters<TModel['update']>[1]

it('types the model timestamps of a SQLite table created before 0.6 as dates', () => {
  const User = defineModel('legacy_date_users', { softDeletes: true })
  type Record = Attributes<typeof User>

  expectTypeOf<Record['created_at']>().toEqualTypeOf<Date | null>()
  expectTypeOf<Record['updated_at']>().toEqualTypeOf<Date | null>()
  expectTypeOf<Record['deleted_at']>().toEqualTypeOf<Date | null>()
  expectTypeOf<Record['birthday']>().toEqualTypeOf<string | null>()
  expectTypeOf<InsertPayload<typeof User>['created_at']>().toEqualTypeOf<Date | null>()
  expectTypeOf<UpdatePayload<typeof User>['updated_at']>().toEqualTypeOf<Date | null | undefined>()
})

it('follows the model timestamp and soft delete options', () => {
  const Untimed = defineModel('legacy_date_users', { timestamps: false })
  const Renamed = defineModel('legacy_date_users', { createdAtColumn: 'birthday', updatedAtColumn: 'updated_at', softDeletes: true, deletedAtColumn: 'deleted_at' })
  const Cast = defineModel('legacy_date_users', { casts: { created_at: 'string' } })

  expectTypeOf<Attributes<typeof Untimed>['created_at']>().toEqualTypeOf<string | null>()
  expectTypeOf<Attributes<typeof Untimed>['deleted_at']>().toEqualTypeOf<string | null>()
  expectTypeOf<Attributes<typeof Renamed>['birthday']>().toEqualTypeOf<Date | null>()
  expectTypeOf<Attributes<typeof Renamed>['created_at']>().toEqualTypeOf<string | null>()
  expectTypeOf<Attributes<typeof Renamed>['deleted_at']>().toEqualTypeOf<Date | null>()
  expectTypeOf<Attributes<typeof Cast>['created_at']>().toEqualTypeOf<string | null>()
  expectTypeOf<Attributes<typeof Cast>['updated_at']>().toEqualTypeOf<Date | null>()
})

it('keeps timestamp columns that are neither text nor dates at their column type', () => {
  const Epoch = defineModel(defineGeneratedTable('legacy_date_epochs', { id: column.id(), created_at: column.integer(), updated_at: column.timestamp() }))

  expectTypeOf<Attributes<typeof Epoch>['created_at']>().toEqualTypeOf<number>()
  expectTypeOf<Attributes<typeof Epoch>['updated_at']>().toEqualTypeOf<Date>()
})

it('types withTimestamps pivot columns as dates', () => {
  const Tag = defineModel('legacy_date_tags')
  const User = defineModel('legacy_date_users', {
    relations: {
      tags: belongsToMany(() => Tag, 'legacy_date_tag_user', 'user_id', 'tag_id').withTimestamps(),
      plainTags: belongsToMany(() => Tag, 'legacy_date_tag_user', 'user_id', 'tag_id'),
    },
  })

  if (false) {
    const check = async () => {
      const user = await User.with('tags', 'plainTags').firstOrFail()
      expectTypeOf(user.tags[0]?.pivot.created_at).toEqualTypeOf<Date | null | undefined>()
      expectTypeOf(user.tags[0]?.pivot.updated_at).toEqualTypeOf<Date | null | undefined>()
      expectTypeOf(user.tags[0]?.created_at).toEqualTypeOf<Date | null | undefined>()
      expectTypeOf(user.plainTags[0]?.pivot.created_at).toEqualTypeOf<string | null | undefined>()
    }
    void check
  }
})

it('types the date columns a generated model registry names', () => {
  type Registered = InferSelect<ModelCastedTable<GeneratedSchemaTable<'legacy_date_users'>, { readonly birthday: 'date' }, 'created_at' | 'deleted_at'>>

  expectTypeOf<Registered['created_at']>().toEqualTypeOf<Date | null>()
  expectTypeOf<Registered['deleted_at']>().toEqualTypeOf<Date | null>()
  expectTypeOf<Registered['birthday']>().toEqualTypeOf<Date | null>()
  expectTypeOf<Registered['updated_at']>().toEqualTypeOf<string | null>()
})
