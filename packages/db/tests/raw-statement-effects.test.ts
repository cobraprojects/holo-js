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
})
