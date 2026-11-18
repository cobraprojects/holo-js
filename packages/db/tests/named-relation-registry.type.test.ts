import { expectTypeOf, it } from 'vitest'
import { belongsTo, scopeRelation } from '../src'
import type {} from './fixtures/named-relations/model-registry'
import NamedRelationAllocation from './fixtures/named-relations/models/NamedRelationAllocation'
import NamedRelationTenant from './fixtures/named-relations/models/NamedRelationTenant'

it('types a nested eager load through relations declared by model name', () => {
  if (false) {
    const query = NamedRelationAllocation.query().with('reward.tenant', 'reward.parent')
    type Allocation = NonNullable<Awaited<ReturnType<typeof query.first>>>
    type Reward = NonNullable<Allocation['reward']>

    expectTypeOf<NonNullable<Reward['tenant']>['display_name']>().toEqualTypeOf<string>()
    expectTypeOf<NonNullable<Reward['parent']>['points']>().toEqualTypeOf<number>()
    // @ts-expect-error tenants have no points column
    expectTypeOf<NonNullable<Reward['tenant']>['points']>()
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
