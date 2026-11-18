import { belongsTo, defineModel } from '@holo-js/db'

export default defineModel('named_relation_allocations', {
  relations: {
    reward: belongsTo('NamedRelationReward', 'reward_id'),
  },
})
