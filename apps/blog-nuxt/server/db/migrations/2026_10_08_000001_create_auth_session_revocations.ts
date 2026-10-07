import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ db }) {
    const stringType = db.getDialect().name === 'mysql'
      ? 'VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin'
      : 'VARCHAR(255)'
    await db.executeCompiled({
      sql: `CREATE TABLE auth_session_revocations (provider ${stringType} NOT NULL, user_id ${stringType} NOT NULL, generation INTEGER NOT NULL DEFAULT 0, retained_session_id ${stringType}, PRIMARY KEY (provider, user_id))`,
      source: 'schema',
    })
  },
  async down({ schema }) {
    await schema.dropTable('auth_session_revocations')
  },
})
