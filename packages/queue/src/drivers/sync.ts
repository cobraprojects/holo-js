import type {
  NormalizedQueueSyncConnectionConfig,
  QueueDriverDispatchResult,
  QueueDriverFactory,
  QueueDriverFactoryContext,
  QueueJobEnvelope,
  QueueJsonValue,
  QueueSyncDriver,
} from '../contracts'

class SyncQueueDriver implements QueueSyncDriver {
  readonly name: string
  readonly driver = 'sync' as const
  readonly mode = 'sync' as const
  private readonly context: QueueDriverFactoryContext

  constructor(
    connection: NormalizedQueueSyncConnectionConfig,
    context: QueueDriverFactoryContext,
  ) {
    this.name = connection.name
    this.context = context
  }

  async dispatch<TPayload extends QueueJsonValue = QueueJsonValue, TResult = unknown>(
    job: QueueJobEnvelope<TPayload>,
  ): Promise<QueueDriverDispatchResult<TResult>> {
    const result = await this.context.execute<TPayload, TResult>(job)
    return {
      jobId: job.id,
      synchronous: true,
      result,
    }
  }

  async clear(): Promise<number> {
    return 0
  }

  async close(): Promise<void> {}
}

export const syncQueueDriverFactory: QueueDriverFactory<NormalizedQueueSyncConnectionConfig> = {
  driver: 'sync',
  create(connection, context) {
    return new SyncQueueDriver(connection, context)
  },
}

export const syncQueueDriverInternals = {
  SyncQueueDriver,
}
