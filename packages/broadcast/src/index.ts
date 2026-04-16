import {
  channel,
  defineBroadcast,
  defineChannel,
  presenceChannel,
  privateChannel,
} from './contracts'
import {
  authorizeBroadcastChannel,
  parseBroadcastAuthEndpointPayload,
  renderBroadcastAuthResponse,
  resolveBroadcastWhisperSchema,
  validateBroadcastWhisperPayload,
} from './auth'
import {
  createBroadcastWorkerRuntime,
  startBroadcastWorker,
} from './worker'
import {
  broadcast,
  broadcastRaw,
  configureBroadcastRuntime,
  getBroadcastRuntime,
  getBroadcastRuntimeBindings,
  resetBroadcastRuntime,
} from './runtime'

export { defineBroadcastConfig } from '@holo-js/config'
export type {
  HoloBroadcastConfig,
  NormalizedHoloBroadcastConfig,
} from '@holo-js/config'

export {
  authorizeBroadcastChannel,
  broadcastAuthInternals,
  parseBroadcastAuthEndpointPayload,
  renderBroadcastAuthResponse,
  resolveBroadcastWhisperSchema,
  validateBroadcastWhisperPayload,
} from './auth'
export {
  createBroadcastWorkerRuntime,
  startBroadcastWorker,
  workerInternals,
} from './worker'
export {
  broadcastInternals,
  channel,
  defineBroadcast,
  defineChannel,
  isBroadcastDefinition,
  isChannelDefinition,
  presenceChannel,
  privateChannel,
} from './contracts'
export type {
  BroadcastChannelsFor,
  BroadcastAuthorizeResult,
  BroadcastAuthEndpointBody,
  BroadcastAuthEndpointErrorBody,
  BroadcastAuthEndpointOptions,
  BroadcastAuthEndpointPayload,
  BroadcastAuthEndpointSuccessBody,
  BroadcastChannelTarget,
  BroadcastChannelType,
  BroadcastChannelAuthFailure,
  BroadcastChannelAuthRequest,
  BroadcastChannelAuthResult,
  BroadcastChannelAuthRuntimeBindings,
  BroadcastChannelAuthSuccess,
  BroadcastDefinition,
  BroadcastDefinitionInput,
  BroadcastDelayValue,
  BroadcastDispatchOptions,
  BroadcastDriver,
  BroadcastDriverExecutionContext,
  BroadcastDriverName,
  BroadcastJsonObject,
  BroadcastJsonPrimitive,
  BroadcastJsonValue,
  BroadcastPayloadFor,
  BroadcastQueueOptions,
  BroadcastRuntimeBindings,
  BroadcastRuntimeFacade,
  BroadcastSendInput,
  BroadcastSendResult,
  BroadcastTargetParamInput,
  BroadcastWhisperDefinitions,
  BroadcastWhisperSchema,
  BuiltInBroadcastDriverRegistry,
  ChannelDefinitionFor,
  ChannelPresenceMemberFor,
  ChannelWhisperPayloadFor,
  ChannelDefinition,
  ChannelDefinitionInput,
  ChannelPatternParams,
  ExportedBroadcastDefinition,
  ExportedChannelDefinition,
  GeneratedBroadcastManifest,
  GeneratedBroadcastManifestChannel,
  GeneratedBroadcastManifestEvent,
  GeneratedChannelAuthRegistryEntry,
  HoloBroadcastDriverRegistry,
  HoloBroadcastRegistry,
  HoloChannelRegistry,
  InferBroadcastWhisperPayload,
  InferChannelPresenceMember,
  InferChannelWhisperPayload,
  InferSchemaOutput,
  PendingBroadcastDispatch,
  RawBroadcastSendInput,
  RegisterBroadcastDriverOptions,
  RegisteredBroadcastDriver,
  ResolvedRawBroadcastSendInput,
  BroadcastWhisperValidationResult,
} from './contracts'
export type {
  BroadcastWorkerRuntime,
  BroadcastWorkerStats,
  StartedBroadcastWorker,
} from './worker'
export {
  broadcast,
  broadcastRaw,
  broadcastRuntimeInternals,
  configureBroadcastRuntime,
  getBroadcastRuntime,
  getBroadcastRuntimeBindings,
  resetBroadcastRuntime,
} from './runtime'
export {
  broadcastRegistryInternals,
  getRegisteredBroadcastDriver,
  listRegisteredBroadcastDrivers,
  registerBroadcastDriver,
  resetBroadcastDriverRegistry,
} from './registry'

const broadcastPackage = Object.freeze({
  authorizeBroadcastChannel,
  broadcast,
  broadcastRaw,
  channel,
  configureBroadcastRuntime,
  defineBroadcast,
  defineChannel,
  getBroadcastRuntime,
  getBroadcastRuntimeBindings,
  parseBroadcastAuthEndpointPayload,
  presenceChannel,
  privateChannel,
  renderBroadcastAuthResponse,
  resetBroadcastRuntime,
  resolveBroadcastWhisperSchema,
  startBroadcastWorker,
  validateBroadcastWhisperPayload,
  createBroadcastWorkerRuntime,
})

export default broadcastPackage
