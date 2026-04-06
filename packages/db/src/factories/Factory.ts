import { HydrationError, SecurityError } from '../core/errors'
import type { Entity } from '../model/Entity'
import type { RelationDefinition } from '../model/types'
import type { TableDefinition } from '../schema/types'
import type {
  FactoryAttributes,
  FactoryContext,
  FactoryDefinition,
  FactoryEntityReference,
  FactoryHook,
  FactoryModelReference,
  FactoryStateDefinition,
} from './types'

type RelatedEntity = FactoryEntityReference<TableDefinition>
type FactorySource = {
  readonly model: Pick<FactoryModelReference, 'definition' | 'getConnectionName' | 'getRepository'>
  getAmount(): number
  createOne(sequence?: number, overrides?: Record<string, unknown>): Promise<RelatedEntity>
  makeOne(sequence?: number, overrides?: Record<string, unknown>): Promise<RelatedEntity>
  createMany(amount?: number, overrides?: Record<string, unknown>): Promise<RelatedEntity[]>
  makeMany(amount?: number, overrides?: Record<string, unknown>): Promise<RelatedEntity[]>
}
type FactoryRepository = {
  readonly definition: { readonly morphClass: string, readonly primaryKey: string, readonly table: { readonly tableName: string } }
  getConnectionName(): string
  getRelationDefinition(name: string): RelationDefinition
  hydrate(attributes: Record<string, unknown>): RelatedEntity
  resolveRelatedRepository(related: unknown): { definition: { morphClass: string } }
}
type ParentRelationSource = FactorySource | RelatedEntity
type AttachedRelationSource = FactorySource | RelatedEntity | readonly RelatedEntity[]

export class Factory<TModel extends FactoryModelReference = FactoryModelReference> {
  private readonly states: FactoryStateDefinition<TModel>[]
  private readonly afterMakingHooks: FactoryHook<TModel>[]
  private readonly afterCreatingHooks: FactoryHook<TModel>[]
  private readonly recycledEntities: RelatedEntity[]
  private readonly parentRelations: Array<{ relation: string, source: ParentRelationSource }>
  private readonly childRelations: Array<{ relation: string, factory: FactorySource }>
  private readonly attachedRelations: Array<{
    relation: string
    source: AttachedRelationSource
    pivotAttributes: Record<string, unknown>
  }>

  private readonly amount: number

  constructor(
    readonly model: TModel,
    private readonly definition: FactoryDefinition<TModel>,
    options: {
      states?: readonly FactoryStateDefinition<TModel>[]
      afterMakingHooks?: readonly FactoryHook<TModel>[]
      afterCreatingHooks?: readonly FactoryHook<TModel>[]
      recycledEntities?: readonly RelatedEntity[]
      parentRelations?: ReadonlyArray<{ relation: string, source: ParentRelationSource }>
      childRelations?: ReadonlyArray<{ relation: string, factory: FactorySource }>
      attachedRelations?: ReadonlyArray<{
        relation: string
        source: AttachedRelationSource
        pivotAttributes: Record<string, unknown>
      }>
      amount?: number
    } = {},
  ) {
    this.states = [...(options.states ?? [])]
    this.afterMakingHooks = [...(options.afterMakingHooks ?? [])]
    this.afterCreatingHooks = [...(options.afterCreatingHooks ?? [])]
    this.recycledEntities = [...(options.recycledEntities ?? [])]
    this.parentRelations = [...(options.parentRelations ?? [])]
    this.childRelations = [...(options.childRelations ?? [])]
    this.attachedRelations = [...(options.attachedRelations ?? [])]
    this.amount = options.amount ?? 1
  }

  count(amount: number): Factory<TModel> {
    return this.clone({ amount })
  }

  getAmount(): number {
    return this.amount
  }

  state(definition: FactoryStateDefinition<TModel>): Factory<TModel> {
    return this.clone({
      states: [...this.states, definition],
    })
  }

  sequence(...definitions: readonly FactoryStateDefinition<TModel>[]): Factory<TModel> {
    if (definitions.length === 0) {
      return this
    }

    return this.state((attributes, context) => {
      const index = (context.sequence - 1) % definitions.length
      const definition = definitions[index]!
      if (typeof definition === 'function') {
        return definition(attributes, context)
      }
      return definition
    })
  }

  afterMaking(hook: FactoryHook<TModel>): Factory<TModel> {
    return this.clone({
      afterMakingHooks: [...this.afterMakingHooks, hook],
    })
  }

  afterCreating(hook: FactoryHook<TModel>): Factory<TModel> {
    return this.clone({
      afterCreatingHooks: [...this.afterCreatingHooks, hook],
    })
  }

  recycle(source: RelatedEntity | readonly RelatedEntity[]): Factory<TModel> {
    const entities = Array.isArray(source) ? [...source] : [source]
    return this.clone({
      recycledEntities: [...this.recycledEntities, ...entities],
    })
  }

  for(source: ParentRelationSource, relation: string): Factory<TModel> {
    return this.clone({
      parentRelations: [...this.parentRelations, { relation, source }],
    })
  }

  has(factory: FactorySource, relation: string): Factory<TModel> {
    return this.clone({
      childRelations: [...this.childRelations, { relation, factory }],
    })
  }

  hasAttached(
    source: AttachedRelationSource,
    relation: string,
    pivotAttributes: Record<string, unknown> = {},
  ): Factory<TModel> {
    return this.clone({
      attachedRelations: [...this.attachedRelations, {
        relation,
        source,
        pivotAttributes: { ...pivotAttributes },
      }],
    })
  }

  async raw(overrides: FactoryAttributes<TModel> = {}): Promise<FactoryAttributes<TModel> | FactoryAttributes<TModel>[]> {
    if (this.amount === 1) {
      return this.resolveAttributes(1, overrides)
    }

    const values: FactoryAttributes<TModel>[] = []
    for (let sequence = 1; sequence <= this.amount; sequence += 1) {
      values.push(await this.resolveAttributes(sequence, overrides))
    }
    return values
  }

  async make(
    overrides: FactoryAttributes<TModel> = {},
  ): Promise<Entity<TModel['definition']['table']> | Array<Entity<TModel['definition']['table']>>> {
    if (this.amount === 1) {
      return this.makeOne(1, overrides)
    }

    const entities: Array<Entity<TModel['definition']['table']>> = []
    for (let sequence = 1; sequence <= this.amount; sequence += 1) {
      entities.push(await this.makeOne(sequence, overrides))
    }
    return entities
  }

  async create(
    overrides: FactoryAttributes<TModel> = {},
  ): Promise<Entity<TModel['definition']['table']> | Array<Entity<TModel['definition']['table']>>> {
    if (this.amount === 1) {
      return this.createOne(1, overrides)
    }

    const entities: Array<Entity<TModel['definition']['table']>> = []
    for (let sequence = 1; sequence <= this.amount; sequence += 1) {
      entities.push(await this.createOne(sequence, overrides))
    }
    return entities
  }

  async makeOne(
    sequence = 1,
    overrides: FactoryAttributes<TModel> = {},
  ): Promise<Entity<TModel['definition']['table']>> {
    const attributes = await this.resolveAttributes(sequence, overrides)
    const entity = this.model.make(attributes) as Entity<TModel['definition']['table']>
    await this.applyParentRelations(entity, false)
    await this.applyChildRelations(entity, false)
    await this.applyAttachedRelations(entity, false)
    await this.runHooks(this.afterMakingHooks, entity, sequence)
    return entity
  }

  async createOne(
    sequence = 1,
    overrides: FactoryAttributes<TModel> = {},
  ): Promise<Entity<TModel['definition']['table']>> {
    const attributes = await this.resolveAttributes(sequence, overrides)
    const prepared = this.model.make(attributes) as Entity<TModel['definition']['table']>
    await this.applyParentRelations(prepared, true)
    const entity = await this.model.create(prepared.toAttributes()) as Entity<TModel['definition']['table']>
    for (const relationName of this.getPreparedRelationNames(prepared)) {
      entity.setRelation(relationName, prepared.getRelation(relationName))
    }
    await this.applyChildRelations(entity, true)
    await this.applyAttachedRelations(entity, true)
    await this.runHooks(this.afterCreatingHooks, entity, sequence)
    return entity
  }

  async makeMany(
    amount = this.amount,
    overrides: FactoryAttributes<TModel> = {},
  ): Promise<Array<Entity<TModel['definition']['table']>>> {
    const entities: Array<Entity<TModel['definition']['table']>> = []
    for (let sequence = 1; sequence <= amount; sequence += 1) {
      entities.push(await this.makeOne(sequence, overrides))
    }
    return entities
  }

  async createMany(
    amount = this.amount,
    overrides: FactoryAttributes<TModel> = {},
  ): Promise<Array<Entity<TModel['definition']['table']>>> {
    const entities: Array<Entity<TModel['definition']['table']>> = []
    for (let sequence = 1; sequence <= amount; sequence += 1) {
      entities.push(await this.createOne(sequence, overrides))
    }
    return entities
  }

  private clone(options: {
    states?: readonly FactoryStateDefinition<TModel>[]
    afterMakingHooks?: readonly FactoryHook<TModel>[]
    afterCreatingHooks?: readonly FactoryHook<TModel>[]
    recycledEntities?: readonly RelatedEntity[]
    parentRelations?: ReadonlyArray<{ relation: string, source: ParentRelationSource }>
    childRelations?: ReadonlyArray<{ relation: string, factory: FactorySource }>
    attachedRelations?: ReadonlyArray<{
      relation: string
      source: AttachedRelationSource
      pivotAttributes: Record<string, unknown>
    }>
    amount?: number
  }): Factory<TModel> {
    return new Factory(this.model, this.definition, {
      states: options.states ?? this.states,
      afterMakingHooks: options.afterMakingHooks ?? this.afterMakingHooks,
      afterCreatingHooks: options.afterCreatingHooks ?? this.afterCreatingHooks,
      recycledEntities: options.recycledEntities ?? this.recycledEntities,
      parentRelations: options.parentRelations ?? this.parentRelations,
      childRelations: options.childRelations ?? this.childRelations,
      attachedRelations: options.attachedRelations ?? this.attachedRelations,
      amount: options.amount ?? this.amount,
    })
  }

  private async resolveAttributes(
    sequence: number,
    overrides: FactoryAttributes<TModel>,
  ): Promise<FactoryAttributes<TModel>> {
    const context = this.makeContext(sequence)
    let attributes = await this.definition(context)

    for (const state of this.states) {
      const patch = typeof state === 'function'
        ? await state(attributes, context)
        : state
      attributes = { ...attributes, ...patch }
    }

    return { ...attributes, ...overrides }
  }

  private async runHooks(
    hooks: readonly FactoryHook<TModel>[],
    entity: Entity<TModel['definition']['table']>,
    sequence: number,
  ): Promise<void> {
    for (const hook of hooks) {
      await hook(entity, this.makeContext(sequence))
    }
  }

  private makeContext(sequence: number): FactoryContext<TModel> {
    return {
      sequence,
      model: this.model,
    }
  }

  private getRepository(): FactoryRepository {
    return this.model.getRepository() as unknown as FactoryRepository
  }

  private getRelationDefinition(name: string): RelationDefinition {
    return this.getRepository().getRelationDefinition(name)
  }

  private getPreparedRelationNames(entity: RelatedEntity): readonly string[] {
    return [
      ...this.parentRelations.map(item => item.relation),
      ...this.childRelations.map(item => item.relation),
      ...this.attachedRelations.map(item => item.relation),
    ].filter((value, index, items) => items.indexOf(value) === index && entity.hasRelation(value))
  }

  private async resolveSingleSource(source: ParentRelationSource, persist: boolean): Promise<RelatedEntity> {
    if ('createOne' in source) {
      const recycled = this.takeRecycledEntities(source, 1)[0]
      if (recycled) {
        if (persist && !recycled.exists()) {
          throw new HydrationError('Factory.recycle() requires persisted related models when using create().')
        }
        return recycled
      }
      return persist ? source.createOne() : source.makeOne()
    }

    if (persist && !source.exists()) {
      throw new HydrationError('Relation-aware factories require persisted related models when using create().')
    }

    return source
  }

  private async resolveManySource(source: AttachedRelationSource, persist: boolean): Promise<RelatedEntity[]> {
    if ('createOne' in source) {
      const amount = source.getAmount()
      const recycled = this.takeRecycledEntities(source, amount)
      if (recycled.length === amount) {
        if (persist && recycled.some(entity => !entity.exists())) {
          throw new HydrationError('Factory.recycle() requires persisted related models when using create().')
        }
        return recycled
      }

      const missing = amount - recycled.length
      const generated = persist ? await source.createMany(missing) : await source.makeMany(missing)
      return [...recycled, ...generated]
    }

    const entities = Array.isArray(source) ? [...source] : [source]
    if (persist && entities.some(entity => !entity.exists())) {
      throw new HydrationError('Relation-aware factories require persisted related models when attaching during create().')
    }

    return entities
  }

  private takeRecycledEntities(source: FactorySource, amount: number): RelatedEntity[] {
    if (amount <= 0) {
      return []
    }

    const tableName = source.model.definition.table.tableName
    const sourceRepository = typeof source.model.getRepository === 'function'
      ? source.model.getRepository() as FactoryRepository
      : undefined
    const connectionName = source.model.getConnectionName?.() ?? sourceRepository?.getConnectionName()
    const matches = this.recycledEntities.filter((entity) => {
      const repository = entity.getRepository() as unknown as FactoryRepository
      return repository.definition.table.tableName === tableName
        && (typeof connectionName === 'undefined' || repository.getConnectionName() === connectionName)
    })

    return matches.slice(0, amount)
  }

  private async applyParentRelations(entity: Entity<TModel['definition']['table']>, persist: boolean): Promise<void> {
    for (const config of this.parentRelations) {
      const relation = this.getRelationDefinition(config.relation)
      const parent = await this.resolveSingleSource(config.source, persist)

      switch (relation.kind) {
        case 'belongsTo': {
          const ownerKey = parent.get(relation.ownerKey as never)
          if (ownerKey !== null && typeof ownerKey !== 'undefined') {
            entity.set(relation.foreignKey as never, ownerKey as never)
          }
          entity.setRelation(config.relation, parent)
          break
        }
        case 'morphTo': {
          const repository = parent.getRepository() as unknown as FactoryRepository
          const parentKey = parent.get(repository.definition.primaryKey as never)
          if (parentKey !== null && typeof parentKey !== 'undefined') {
            entity.set(relation.morphTypeColumn as never, repository.definition.morphClass as never)
            entity.set(relation.morphIdColumn as never, parentKey as never)
          }
          entity.setRelation(config.relation, parent)
          break
        }
        default:
          throw new SecurityError(`Factory.for() supports belongsTo and morphTo only. "${config.relation}" is "${relation.kind}".`)
      }
    }
  }

  private async applyChildRelations(entity: Entity<TModel['definition']['table']>, persist: boolean): Promise<void> {
    for (const config of this.childRelations) {
      const relation = this.getRelationDefinition(config.relation)

      switch (relation.kind) {
        case 'hasOne':
        case 'hasOneOfMany': {
          const child = persist
            ? await config.factory.createOne(1, this.makeChildOverrides(entity, relation))
            : await config.factory.makeOne(1, this.makeChildOverrides(entity, relation))
          entity.setRelation(config.relation, child)
          break
        }
        case 'hasMany': {
          const children = persist
            ? await config.factory.createMany(undefined, this.makeChildOverrides(entity, relation))
            : await config.factory.makeMany(undefined, this.makeChildOverrides(entity, relation))
          entity.setRelation(config.relation, children)
          break
        }
        case 'morphOne':
        case 'morphOneOfMany': {
          const child = persist
            ? await config.factory.createOne(1, this.makeMorphChildOverrides(entity, relation))
            : await config.factory.makeOne(1, this.makeMorphChildOverrides(entity, relation))
          entity.setRelation(config.relation, child)
          break
        }
        case 'morphMany': {
          const children = persist
            ? await config.factory.createMany(undefined, this.makeMorphChildOverrides(entity, relation))
            : await config.factory.makeMany(undefined, this.makeMorphChildOverrides(entity, relation))
          entity.setRelation(config.relation, children)
          break
        }
        default:
          throw new SecurityError(`Factory.has() supports hasOne, hasMany, morphOne, and morphMany relations only. "${config.relation}" is "${relation.kind}".`)
      }
    }
  }

  private async applyAttachedRelations(entity: Entity<TModel['definition']['table']>, persist: boolean): Promise<void> {
    for (const config of this.attachedRelations) {
      const relation = this.getRelationDefinition(config.relation)
      if (
        relation.kind !== 'belongsToMany'
        && relation.kind !== 'morphToMany'
        && relation.kind !== 'morphedByMany'
      ) {
        throw new SecurityError(`Factory.hasAttached() supports pivot-backed many-to-many relations only. "${config.relation}" is "${relation.kind}".`)
      }

      const relatedEntities = await this.resolveManySource(config.source, persist)
      if (persist && relatedEntities.length > 0) {
        const payload = Object.fromEntries(relatedEntities.map((related) => {
          const relatedId = related.get(relation.relatedKey as never)
          return [String(relatedId), { ...config.pivotAttributes }]
        }))
        await entity.attach(config.relation, payload)
      }

      entity.setRelation(
        config.relation,
        relatedEntities.map(related => this.attachPivotAccessor(entity, related, relation, config.pivotAttributes)),
      )
    }
  }

  private makeChildOverrides(
    entity: Entity<TModel['definition']['table']>,
    relation: Extract<RelationDefinition, { kind: 'hasOne' | 'hasOneOfMany' | 'hasMany' }>,
  ): Record<string, unknown> {
    const localValue = entity.get(relation.localKey as never)
    if (localValue === null || typeof localValue === 'undefined') {
      return {}
    }

    return {
      [relation.foreignKey]: localValue,
    }
  }

  private makeMorphChildOverrides(
    entity: Entity<TModel['definition']['table']>,
    relation: Extract<RelationDefinition, { kind: 'morphOne' | 'morphOneOfMany' | 'morphMany' }>,
  ): Record<string, unknown> {
    const localValue = entity.get(relation.localKey as never)
    if (localValue === null || typeof localValue === 'undefined') {
      return {}
    }

    return {
      [relation.morphTypeColumn]: this.model.definition.morphClass,
      [relation.morphIdColumn]: localValue,
    }
  }

  private attachPivotAccessor(
    entity: Entity<TModel['definition']['table']>,
    related: RelatedEntity,
    relation: Extract<RelationDefinition, { kind: 'belongsToMany' | 'morphToMany' | 'morphedByMany' }>,
    attributes: Record<string, unknown>,
  ): RelatedEntity {
    const pivotRelated = (related.getRepository() as unknown as FactoryRepository).hydrate(related.toAttributes())
    const parentId = entity.get(relation.parentKey as never)
    const relatedId = related.get(relation.relatedKey as never)

    switch (relation.kind) {
      case 'belongsToMany':
        pivotRelated.setRelation(relation.pivotAccessor, {
          [relation.foreignPivotKey]: parentId,
          [relation.relatedPivotKey]: relatedId,
          ...attributes,
        })
        return pivotRelated
      case 'morphToMany':
        pivotRelated.setRelation(relation.pivotAccessor, {
          [relation.morphTypeColumn]: this.model.definition.morphClass,
          [relation.morphIdColumn]: parentId,
          [relation.foreignPivotKey]: relatedId,
          ...attributes,
        })
        return pivotRelated
      case 'morphedByMany': {
        const relatedRepository = this.getRepository().resolveRelatedRepository(relation.related)
        pivotRelated.setRelation(relation.pivotAccessor, {
          [relation.foreignPivotKey]: parentId,
          [relation.morphTypeColumn]: relatedRepository.definition.morphClass,
          [relation.morphIdColumn]: relatedId,
          ...attributes,
        })
        return pivotRelated
      }
    }
  }
}
