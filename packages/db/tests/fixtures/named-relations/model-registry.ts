import './schema.generated'
import type { EmptyScopeMap, GeneratedSchemaTable, ModelReference } from '@holo-js/db'
import type * as holoModelModule0 from './models/NamedRelationAllocation'
import type * as holoModelModule1 from './models/NamedRelationReward'
import type * as holoModelModule2 from './models/NamedRelationTenant'

type HoloModel0 = ModelReference<GeneratedSchemaTable<"named_relation_allocations">, EmptyScopeMap>
type HoloModel1 = ModelReference<GeneratedSchemaTable<"named_relation_rewards">, EmptyScopeMap>
type HoloModel2 = ModelReference<GeneratedSchemaTable<"named_relation_tenants">, EmptyScopeMap>

declare module '@holo-js/db' {
  interface RegisteredModels {
    readonly "NamedRelationAllocation": HoloModel0
    readonly "NamedRelationReward": HoloModel1
    readonly "NamedRelationTenant": HoloModel2
  }

  interface RegisteredModelDefinitions {
    readonly "NamedRelationAllocation": typeof holoModelModule0["default"]
    readonly "NamedRelationReward": typeof holoModelModule1["default"]
    readonly "NamedRelationTenant": typeof holoModelModule2["default"]
  }
}

export {}
