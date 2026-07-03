import type {
  RealtimeExecutionOptions,
  RealtimeQueryDefinitionMetadata,
} from '../contracts'
import { stableStringify } from './stable-stringify'

export function createRefreshKey(
  definition: RealtimeQueryDefinitionMetadata,
  args: Record<string, unknown>,
  subscriptionId: string,
  executionOptions: RealtimeExecutionOptions | undefined,
): string {
  if (executionOptions) {
    return subscriptionId
  }

  return `${definition.name}:${stableStringify(args)}`
}
