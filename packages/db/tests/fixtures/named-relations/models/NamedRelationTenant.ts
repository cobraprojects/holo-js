import { defineModel, hasMany, scopeRelation } from '@holo-js/db'

export default defineModel('named_relation_tenants', {
  relations: {
    rewards: hasMany('NamedRelationReward', 'tenant_id'),
    bigRewards: scopeRelation(hasMany('NamedRelationReward', 'tenant_id'), query => query.where('points', '>', 100)),
  },
})
