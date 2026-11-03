import { unquoteStringLiteral } from './sqlDefinitions'
import { findClosingParenthesis } from './sqliteTokens'
import type { DatabaseColumnDefault } from './types'

const CURRENT_TIME_PATTERN = /^(?:CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|LOCALTIMESTAMP|LOCALTIME|now)(?:\s*\(\s*\d*\s*\))?$/i
const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i
const STRING_LITERAL_PATTERN = /^'(?:[^']|'')*'$/
const TRAILING_CAST_PATTERN = /::[\w\s]+(?:\(\d+(?:,\s*\d+)?\))?(?:\[\])?$/

function isWrappedInParentheses(expression: string): boolean {
  return expression.startsWith('(') && findClosingParenthesis(expression, 0) === expression.length - 1
}

function stripOuterParentheses(expression: string): string {
  let current = expression.trim()
  while (isWrappedInParentheses(current)) {
    current = current.slice(1, -1).trim()
  }
  return current
}

function stripCasts(expression: string): string {
  let current = stripOuterParentheses(expression)
  while (TRAILING_CAST_PATTERN.test(current)) {
    current = stripOuterParentheses(current.replace(TRAILING_CAST_PATTERN, ''))
  }
  return current
}

export function parseSqlDefault(expression: string | null): DatabaseColumnDefault {
  if (expression === null) return { kind: 'none' }
  const value = stripCasts(expression)
  if (/^NULL$/i.test(value)) return { kind: 'literal', value: null }
  if (CURRENT_TIME_PATTERN.test(value)) return { kind: 'now' }
  if (STRING_LITERAL_PATTERN.test(value)) return { kind: 'literal', value: unquoteStringLiteral(value) }
  if (NUMBER_PATTERN.test(value)) return { kind: 'literal', value: Number(value) }
  if (/^TRUE$/i.test(value)) return { kind: 'literal', value: true }
  if (/^FALSE$/i.test(value)) return { kind: 'literal', value: false }
  return { kind: 'expression', sql: expression }
}
