import { DB, defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema, db }) {
    await schema.createTable('tenant_records', table => {
      table.string('tenant_id')
      table.string('value')
      table.unique(['tenant_id', 'value'])
    })
    if (db.getDialect().name === 'postgres') {
      await db.unsafeExecute(DB.raw(`
        ALTER TABLE tenant_records ENABLE ROW LEVEL SECURITY;
        ALTER TABLE tenant_records FORCE ROW LEVEL SECURITY;
        CREATE POLICY tenant_context ON tenant_records
          USING (tenant_id = nullif(current_setting('holo.tenant_id', true), ''))
          WITH CHECK (tenant_id = nullif(current_setting('holo.tenant_id', true), ''));
      `))
    }
  },
  async down({ schema }) {
    await schema.dropTable('tenant_records')
  },
})
