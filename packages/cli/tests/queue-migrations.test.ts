import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  renderFailedJobsTableMigration,
  renderQueueTableMigration,
} from '../src/queue-migrations'

describe('queue migration rendering', () => {
  it('escapes configured queue table names and derived index names', () => {
    const queueTable = 'jobs\'); throw new Error(\'owned\');//.queue'
    const failedJobsTable = 'failed"jobs.queue'
    const queueIndexPrefix = queueTable.replaceAll('.', '_')
    const failedJobsIndexPrefix = failedJobsTable.replaceAll('.', '_')
    const queueMigration = renderQueueTableMigration(queueTable)
    const failedJobsMigration = renderFailedJobsTableMigration(failedJobsTable)

    for (const migrationSource of [queueMigration, failedJobsMigration]) {
      const result = ts.transpileModule(migrationSource, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
        reportDiagnostics: true,
      })
      expect(result.diagnostics?.map(diagnostic => diagnostic.code) ?? []).toEqual([])
    }

    expect(queueMigration).toContain('schema.createTable(\'jobs\\\'); throw new Error(\\\'owned\\\');//.queue\',')
    expect(queueMigration).toContain('schema.dropTable(\'jobs\\\'); throw new Error(\\\'owned\\\');//.queue\')')
    expect(queueMigration).toContain(`table.index(['queue', 'available_at'], '${queueIndexPrefix.replaceAll('\'', '\\\'')}_queue_available_at_index')`)
    expect(failedJobsMigration).toContain('schema.createTable(\'failed"jobs.queue\',')
    expect(failedJobsMigration).toContain('schema.dropTable(\'failed"jobs.queue\')')
    expect(failedJobsMigration).toContain(`table.index(['job_id'], '${failedJobsIndexPrefix}_job_id_index')`)
  })
})
