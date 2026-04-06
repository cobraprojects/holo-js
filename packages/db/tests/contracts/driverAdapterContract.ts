import { describe, expect, it } from 'vitest'
import { TransactionError, type DriverAdapter, type DriverExecutionResult, type DriverQueryResult } from '../../src'

type LogEntry = {
  sql: string
  bindings: readonly unknown[]
}

export interface DriverAdapterContractCase {
  readonly name: string
  readonly startsConnected?: boolean
  createAdapter(): DriverAdapter
  readonly query: {
    sql: string
    bindings?: readonly unknown[]
    expected: DriverQueryResult<Record<string, unknown>>
    getLog(): readonly LogEntry[]
  }
  readonly introspection: {
    sql: string
    bindings?: readonly unknown[]
    expected: DriverQueryResult<Record<string, unknown>>
    getLog(): readonly LogEntry[]
  }
  readonly execute: {
    sql: string
    bindings?: readonly unknown[]
    expected: DriverExecutionResult
  }
  readonly transaction: {
    readonly supportsSavepoints: boolean
    readonly validSavepointName: string
    readonly invalidSavepointName: string
    readonly expectedLog: readonly LogEntry[]
    readonly expectedNestedBeginLog?: readonly LogEntry[]
    getLog(): readonly LogEntry[]
  }
  assertDisconnected(): void
  assertTransactionDisconnected?(): void
}

export function runDriverAdapterContractSuite(testCase: DriverAdapterContractCase): void {
  describe(`${testCase.name} driver contract`, () => {
    it('covers lifecycle plus root query and execute behavior', async () => {
      const adapter = testCase.createAdapter()

      expect(adapter.isConnected()).toBe(testCase.startsConnected ?? false)
      await adapter.initialize()
      expect(adapter.isConnected()).toBe(true)

      await expect(adapter.query(
        testCase.query.sql,
        testCase.query.bindings ?? [],
      )).resolves.toEqual(testCase.query.expected)
      expect(testCase.query.getLog()).toEqual([{
        sql: testCase.query.sql,
        bindings: testCase.query.bindings ?? [],
      }])

      await expect(adapter.execute(
        testCase.execute.sql,
        testCase.execute.bindings ?? [],
      )).resolves.toEqual(testCase.execute.expected)

      await adapter.disconnect()
      expect(adapter.isConnected()).toBe(false)
      testCase.assertDisconnected()
      await adapter.disconnect()
    })

    it('covers introspection through the shared contract', async () => {
      const adapter = testCase.createAdapter()

      await adapter.initialize()
      await expect(adapter.introspect?.(
        testCase.introspection.sql,
        testCase.introspection.bindings ?? [],
      )).resolves.toEqual(testCase.introspection.expected)
      expect(testCase.introspection.getLog()).toEqual([{
        sql: testCase.introspection.sql,
        bindings: testCase.introspection.bindings ?? [],
      }])

      await adapter.disconnect()
    })

    it('covers transactions and savepoints through the shared contract', async () => {
      const adapter = testCase.createAdapter()

      await adapter.beginTransaction()
      await adapter.query(testCase.query.sql, testCase.query.bindings ?? [])
      await adapter.execute(testCase.execute.sql, testCase.execute.bindings ?? [])

      if (testCase.transaction.supportsSavepoints) {
        await adapter.createSavepoint?.(testCase.transaction.validSavepointName)
        await adapter.rollbackToSavepoint?.(testCase.transaction.validSavepointName)
        await adapter.releaseSavepoint?.(testCase.transaction.validSavepointName)
      }

      await adapter.commit()

      expect(testCase.transaction.getLog()).toEqual(testCase.transaction.expectedLog)

      await adapter.beginTransaction()
      await expect(adapter.createSavepoint?.(testCase.transaction.invalidSavepointName)).rejects.toThrow(TransactionError)
      await adapter.rollback()
      await adapter.disconnect()
      testCase.assertTransactionDisconnected?.()
    })

    it('reuses the active transaction client/connection on nested begin calls', async () => {
      if (!testCase.transaction.expectedNestedBeginLog) {
        return
      }

      const adapter = testCase.createAdapter()
      await adapter.beginTransaction()
      await adapter.beginTransaction()
      await adapter.rollback()

      expect(testCase.transaction.getLog()).toEqual(testCase.transaction.expectedNestedBeginLog)
      await adapter.disconnect()
    })
  })
}
