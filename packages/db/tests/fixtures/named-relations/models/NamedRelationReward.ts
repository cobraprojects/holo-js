import { belongsTo, defineModel, hasMany, scopeRelation, type ModelQueryBuilder, type GeneratedSchemaTable } from '@holo-js/db'

export default defineModel('named_relation_rewards', {
  accessors: { label: () => 'Reward' },
  appended: ['label'],
  scopes: {
    generous(query: ModelQueryBuilder<GeneratedSchemaTable<'named_relation_rewards'>>) {
      return query.where('points', '>', 1000)
    },
  },
  relations: {
    tenant: scopeRelation(belongsTo('NamedRelationTenant', 'tenant_id'), query => query.where('display_name', '!=', '')),
    parent: scopeRelation(belongsTo('NamedRelationReward', 'parent_id'), query => query.where('points', '>', 0)),
    allocations: hasMany('NamedRelationAllocation', 'reward_id'),
  },
})
