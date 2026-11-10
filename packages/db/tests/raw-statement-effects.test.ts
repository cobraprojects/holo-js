import { describe, expect, it } from 'vitest'
import { isSchemaPreservingRawStatement } from '../src/core/rawStatementEffects'

describe('raw statement schema effects', () => {
  it.each([
    'SELECT 1',
    '  -- leading note\n/* block */ (SELECT "id" FROM "posts")',
    'with recent as (select 1) select * from recent',
    'INSERT INTO posts (id) VALUES (1)',
    'UPDATE posts SET name = \'a\' WHERE id = 1',
    'DELETE FROM posts',
    'SHOW TABLES',
    'EXPLAIN SELECT 1',
    'SAVEPOINT before_import',
    'RELEASE SAVEPOINT before_import',
    'LOCK TABLE posts IN SHARE MODE',
  ])('keeps the schema generation for %s', (sql) => {
    expect(isSchemaPreservingRawStatement(sql)).toBe(true)
  })

  it.each([
    'CREATE TABLE posts (id INTEGER)',
    'ALTER TABLE posts ADD COLUMN name TEXT',
    'DROP TABLE posts',
    'SET search_path TO tenant',
    'USE tenant',
    'ATTACH DATABASE \':memory:\' AS aux',
    'PRAGMA foreign_keys = ON',
    'SET LOCAL search_path TO tenant',
    'SET SCHEMA \'tenant\'',
    'SET ROLE tenant_owner',
    'SET SESSION AUTHORIZATION tenant_owner',
    'RESET search_path',
    'RESET ALL',
    'SET LOCAL statement_timeout = 5000',
    'SET TIME ZONE \'UTC\'',
    'SET NAMES utf8mb4',
    'EXPLAIN ANALYZE CREATE TABLE archived AS SELECT 1',
    'ROLLBACK TO SAVEPOINT before_import',
    'CALL rebuild_reports()',
    'SELECT set_config(\'search_path\', \'tenant\', false)',
    'SELECT * INTO archived_posts FROM posts',
    'SELECT 1; DROP TABLE posts',
    '/* unterminated',
    '',
  ])('advances the schema generation for %s', (sql) => {
    expect(isSchemaPreservingRawStatement(sql)).toBe(false)
  })

  it.each([
    ['sqlite', "UPDATE posts SET name = 'search_path; set_config(''x'')' /* ; DROP TABLE posts */; -- tail"],
    ['sqlite', "SELECT 'into; set_config' AS [search_path]"],
    ['postgres', "SELECT $text$search_path; set_config('x')$text$ /* outer /* nested */ ; INTO ignored */;"],
    ['postgres', String.raw`SELECT E'escaped\' search_path; set_config(ignored)'`],
    ['mysql', String.raw`SELECT 'search_path; set_config(\'ignored\')' # ; INTO ignored`],
    ['mysql', 'SELECT "search_path; set_config(ignored)"; -- tail'],
  ])('keeps literal and comment contents inert on %s: %s', (dialect, sql) => {
    expect(isSchemaPreservingRawStatement(sql, dialect)).toBe(true)
  })

  it.each([
    ['postgres', `SELECT pg_catalog."set_config" /* comment */ ('statement_timeout', '1000', false)`],
    ['postgres', String.raw`SELECT U&"set\005fconfig"('statement_timeout', '1000', false)`],
    ['postgres', "SELECT 'safe'; /* outer /* nested */ ignored */ SET ROLE tenant"],
    ['postgres', "SELECT 1 -- comment\r; SET ROLE tenant"],
    ['postgres', 'SELECT été$tag$; RESET ROLE; SELECT $tag$'],
    ['postgres', String.raw`SELECT 'backslash\', set_config('statement_timeout', '1000', false)`],
    ['postgres', String.raw`SELECT 'backslash\', set_config FROM posts`],
    ['mysql', 'SELECT 1 /*! ; SET SESSION sql_mode = NO_BACKSLASH_ESCAPES */'],
    ['mysql', 'SELECT 1--2; SET NAMES utf8mb4'],
    ['mysql', String.raw`SELECT 'backslash\'; SET NAMES utf8mb4 -- '`],
    ['sqlite', "SELECT 'safe'; ATTACH DATABASE ':memory:' AS aux"],
    ['sqlite', "SELECT 'unterminated"],
  ])('retains conservative session classification on %s: %s', (dialect, sql) => {
    expect(isSchemaPreservingRawStatement(sql, dialect)).toBe(false)
  })
})
