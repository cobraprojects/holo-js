import { AsyncLocalStorage } from 'node:async_hooks'
import { getNextRequestStore } from './request-store'

getNextRequestStore(AsyncLocalStorage)

export { getCurrentNextRequest, runWithNextRequest, type NextRequestLike } from './request-context'
