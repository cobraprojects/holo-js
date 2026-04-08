declare module 'bullmq' {
  export interface ConnectionOptions {
    host?: string
    port?: number
    username?: string
    password?: string
    db?: number
    maxRetriesPerRequest?: null
  }

  export interface Job<TData = unknown, TResult = unknown, TName extends string = string> {
    id?: string
    name: TName
    data: TData
    attemptsStarted?: number
    attemptsMade?: number
    timestamp: number
    opts: { attempts?: number; delay?: number }
    moveToCompleted(result: TResult, token: string, fetchNext?: boolean): Promise<unknown>
    moveToFailed(error: Error, token: string, fetchNext?: boolean): Promise<unknown>
    moveToDelayed(timestamp: number, token?: string): Promise<unknown>
    moveToWait(token: string): Promise<unknown>
    retry(state?: string): Promise<unknown>
    remove(): Promise<void>
    discard(): void
  }

  export class Queue<TData = unknown, TResult = unknown, TName extends string = string> {
    constructor(name: string, options?: unknown)
    add(name: TName, data: TData, options?: unknown): Promise<{ id?: string }>
    count(): Promise<number>
    getJobCountByTypes(...types: string[]): Promise<number>
    drain(includeDelayed?: boolean): Promise<void>
    close(): Promise<void>
  }

  export class Worker<TData = unknown, TResult = unknown, TName extends string = string> {
    constructor(name: string, processor?: unknown, options?: unknown)
    waitUntilReady(): Promise<void>
    getNextJob(token: string, options?: { block?: boolean }): Promise<Job<TData, TResult, TName> | null>
    close(force?: boolean): Promise<void>
  }
}
