import { expectTypeOf, it } from 'vitest'
import { DB, type GeneratedSchemaTable, type InferInsert, type InferSelect } from '../src'
import type {} from './fixtures/primary-keys/sqlite.generated'
import type {} from './fixtures/primary-keys/postgres.generated'
import type {} from './fixtures/primary-keys/mysql.generated'

type PivotTableName = 'primary_keys_post_tag_sqlite' | 'primary_keys_post_tag_postgres' | 'primary_keys_post_tag_mysql'
type Flat<TValue> = { [K in keyof TValue]: TValue[K] }

type PivotTable<TName extends PivotTableName> = GeneratedSchemaTable<TName>

it('types a composite-key pivot table read from SQLite, PostgreSQL and MySQL by its concrete columns', () => {
  expectTypeOf<InferSelect<PivotTable<'primary_keys_post_tag_sqlite'>>>().toEqualTypeOf<{ post_id: number, tag_id: number, weight: number }>()
  expectTypeOf<InferSelect<PivotTable<'primary_keys_post_tag_postgres'>>>().toEqualTypeOf<{ post_id: number, tag_id: number, weight: number }>()
  expectTypeOf<InferSelect<PivotTable<'primary_keys_post_tag_mysql'>>>().toEqualTypeOf<{ post_id: number, tag_id: number, weight: number }>()
  expectTypeOf<Flat<InferInsert<PivotTable<'primary_keys_post_tag_sqlite'>>>>().toEqualTypeOf<{ post_id: number, tag_id: number, weight?: number }>()
  expectTypeOf<PivotTable<'primary_keys_post_tag_postgres'>['columns']['post_id']['primaryKey']>().toEqualTypeOf<true>()
  expectTypeOf<PivotTable<'primary_keys_post_tag_postgres'>['columns']['tag_id']['primaryKey']>().toEqualTypeOf<true>()
  expectTypeOf<PivotTable<'primary_keys_post_tag_mysql'>['columns']['weight']['primaryKey']>().toEqualTypeOf<false>()

  if (false) {
    const check = async (table: PivotTable<'primary_keys_post_tag_mysql'>) => {
      const row = await DB.table(table).where('post_id', 1).where('tag_id', 2).first()
      expectTypeOf(row).toEqualTypeOf<{ post_id: number, tag_id: number, weight: number } | undefined>()
    }
    void check
  }
})
