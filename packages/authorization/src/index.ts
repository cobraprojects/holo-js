import type { AuthorizationFacade } from './contracts'

export {
  allow,
  deny,
  denyAsNotFound,
  isAuthorizationAbilityDefinition,
  isAuthorizationDecision,
  isAuthorizationPolicyDefinition,
  normalizeAuthorizationDecision,
  AuthorizationAbilityNotFoundError,
  AuthorizationAuthIntegrationMissingError,
  AuthorizationError,
  AuthorizationGuardNotFoundError,
  AuthorizationPolicyNotFoundError,
} from './contracts'
export type {
  AbilityInput,
  AuthorizationActorBuilder,
  AuthorizationActorContext,
  AuthorizationAbilityBuilder,
  AuthorizationAbilityHandler,
  AuthorizationAbilityRegistry,
  AuthorizationAbilityRegistryEntry,
  AuthorizationDecision,
  AuthorizationDecisionInput,
  AuthorizationDecisionStatus,
  AuthorizationFacade,
  AuthorizationGuardActorContext,
  AuthorizationPolicyBeforeHandler,
  AuthorizationPolicyBuilder,
  AuthorizationPolicyClassHandler,
  AuthorizationPolicyDefinition,
  AuthorizationPolicyRegistry,
  AuthorizationPolicyRecordHandler,
  AuthorizationPolicyRegistryEntry,
  AuthorizationPolicyTarget,
  AuthorizationTargetConstructor,
  AuthorizationTargetInstance,
  AuthorizationTargetModel,
  AuthorizationTargetModelDefinition,
  HoloAbilityName,
  HoloAuthorizationGuardName,
  HoloPolicyName,
  PolicyActionFor,
  PolicyActionForPolicy,
  PolicyClassActionFor,
  PolicyClassActionForPolicy,
  PolicyInstanceForPolicy,
  PolicyRecordActionFor,
  PolicyRecordActionForPolicy,
  PolicyTargetForPolicy,
} from './contracts'
export {
  authorize,
  authorizationInternals,
  can,
  cannot,
  defineAbility,
  definePolicy,
  forUser,
  guard,
  inspect,
} from './runtime'

import { authorize, can, cannot, forUser, guard, inspect } from './runtime'

const authorization: AuthorizationFacade = Object.freeze({
  forUser,
  guard,
  authorize,
  can,
  cannot,
  inspect,
})

export default authorization
