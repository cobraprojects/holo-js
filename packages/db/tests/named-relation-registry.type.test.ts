import { expectTypeOf, it } from 'vitest'
import { belongsTo, defineModel, hasMany, scopeRelation } from '../src'
import type {} from './fixtures/named-relations/model-registry'
import NamedRelationAllocation from './fixtures/named-relations/models/NamedRelationAllocation'
import NamedRelationReward from './fixtures/named-relations/models/NamedRelationReward'
import NamedRelationTenant from './fixtures/named-relations/models/NamedRelationTenant'

it('types a nested eager load through relations declared by model name', async () => {
  if (false) {
    const query = NamedRelationAllocation.query().with('reward.tenant', 'reward.parent')
    type Allocation = NonNullable<Awaited<ReturnType<typeof query.first>>>
    type Reward = NonNullable<Allocation['reward']>

    expectTypeOf<NonNullable<Reward['tenant']>['display_name']>().toEqualTypeOf<string>()
    expectTypeOf<NonNullable<Reward['parent']>['points']>().toEqualTypeOf<number>()
    expectTypeOf<ReturnType<Reward['attributesToJSON']>['label']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<ReturnType<NonNullable<Reward['tenant']>['attributesToJSON']>['created_at']>().toEqualTypeOf<number | undefined>()
    // @ts-expect-error tenants have no points column
    expectTypeOf<NonNullable<Reward['tenant']>['points']>()

    const tenant = await NamedRelationTenant.firstOrFail()
    const created = await tenant.rewards().create({ points: 100 })
    expectTypeOf(created.attributesToJSON().label).toEqualTypeOf<string | undefined>()
    const Holder = defineModel('named_relation_rewards', { relations: { tenant: hasMany('NamedRelationTenant', 'id') } })
    const holder = await Holder.firstOrFail()
    const createdTenant = await holder.tenant().create({ display_name: 'Acme' })
    expectTypeOf(createdTenant.attributesToJSON().created_at).toEqualTypeOf<number | undefined>()
  }
})

it('types eager loads that walk a cycle of models related by name', () => {
  if (false) {
    const query = NamedRelationTenant.query().with('rewards.allocations.reward.tenant')
    type Tenant = NonNullable<Awaited<ReturnType<typeof query.first>>>
    type Allocation = Tenant['rewards'][number]['allocations'][number]

    expectTypeOf<Allocation['quantity']>().toEqualTypeOf<number>()
    expectTypeOf<NonNullable<NonNullable<Allocation['reward']>['tenant']>['display_name']>().toEqualTypeOf<string>()
  }
})

it('accepts a model loaded through a relation where the model itself is expected', async () => {
  if (false) {
    const reward = await NamedRelationReward.query().with('tenant', 'allocations').firstOrFail()
    const tenant: Awaited<ReturnType<typeof NamedRelationTenant.findOrFail>> = reward.tenant!
    const allocation: Awaited<ReturnType<typeof NamedRelationAllocation.findOrFail>> = reward.allocations[0]!
    const allocated = await NamedRelationAllocation.query().with('reward').firstOrFail()
    const allocatedReward: Awaited<ReturnType<typeof NamedRelationReward.findOrFail>> = allocated.reward!

    expectTypeOf(tenant).not.toBeAny()
    expectTypeOf(allocation).not.toBeAny()
    expectTypeOf(allocatedReward).not.toBeAny()
  }
})

it('exposes the named target model scopes to query callbacks', () => {
  if (false) {
    NamedRelationTenant.query().with('rewards', query => query.generous())
    NamedRelationTenant.query().whereHas('rewards', query => query.generous().where('points', '>', 5))
    NamedRelationAllocation.query().with('reward.parent', query => query.generous())
    // @ts-expect-error tenants have no generous scope
    NamedRelationAllocation.query().with('reward.tenant', query => query.generous())
  }
})

it('types scoped relation constraints against the named target columns', () => {
  scopeRelation(belongsTo('NamedRelationTenant', 'tenant_id'), query => query.where('display_name', 'Acme'))
  // @ts-expect-error tenants have no points column
  scopeRelation(belongsTo('NamedRelationTenant', 'tenant_id'), query => query.where('points', 1))
})

it('keeps relations and scopes of a resolver that returns either a model or its definition', () => {
  const Tenant = defineModel('named_relation_tenants', {
    relations: {
      rewards: hasMany(() => Math.random() > 0.5 ? NamedRelationReward : NamedRelationReward.definition, 'tenant_id'),
    },
  })

  if (false) {
    const query = Tenant.query().with('rewards', rewards => rewards.generous()).with('rewards.tenant')
    type Reward = NonNullable<Awaited<ReturnType<typeof query.first>>>['rewards'][number]
    expectTypeOf<NonNullable<Reward['tenant']>['display_name']>().toEqualTypeOf<string>()
  }
})
