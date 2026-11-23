import { belongsTo, defineModel } from '@holo-js/db'

class Hundredths {
  get(value: unknown) {
    return Number(value) / 100
  }

  set(value: unknown) {
    return Math.round(Number(value) * 100)
  }
}

export default defineModel('named_relation_allocations', {
  casts: { quantity: new Hundredths() },
  relations: {
    reward: belongsTo('NamedRelationReward', 'reward_id'),
  },
})
