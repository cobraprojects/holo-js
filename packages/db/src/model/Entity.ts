import { HydrationError } from '../core/errors'
import type { TableDefinition } from '../schema/types'
import type { AnyModelDefinition, EmptyScopeMap, ModelAggregateLoad, ModelMorphLoadMap, ModelRecord, ModelRelationName, ModelRelationPath, ModelRepositoryLike, ModelUpdatePayload, RelatedColumnNameOfRelation, RelationMap, ResolveEagerLoads, SerializeLoaded } from './types'

type EntityConstructor = {
  new<
    TTable extends TableDefinition = TableDefinition,
    TRelations extends RelationMap = RelationMap,
  >(
    repository: ModelRepositoryLike<TTable, EmptyScopeMap, TRelations>,
    attributes: Partial<ModelRecord<TTable>>,
    exists?: boolean,
  ): Entity<TTable, TRelations>
  prototype: EntityBase<TableDefinition, RelationMap>
}

function isEntity(value: unknown): value is Entity<TableDefinition, RelationMap> {
  return value instanceof EntityBase
}

function valuesAreEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true
  }

  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime()
  }

  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    if (left.length !== right.length) {
      return false
    }

    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) {
        return false
      }
    }

    return true
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => valuesAreEqual(value, right[index]))
  }

  if (
    left
    && right
    && typeof left === 'object'
    && typeof right === 'object'
    && Object.getPrototypeOf(left) === Object.getPrototypeOf(right)
  ) {
    const leftEntries = Object.entries(left)
    const rightEntries = Object.entries(right)

    if (leftEntries.length !== rightEntries.length) {
      return false
    }

    return leftEntries.every(([key, value]) => valuesAreEqual(value, (right as Record<string, unknown>)[key]))
  }

  return false
}

type EntityRepositoryRuntime<TTable extends TableDefinition, TRelations extends RelationMap> = ModelRepositoryLike<TTable, EmptyScopeMap, TRelations> & {
  readonly definition: AnyModelDefinition
  getConnectionName(): string
  getDeletedAtColumn?(): string | undefined
  shouldPreventAccessingMissingAttributes?(key: string): boolean
  resolveAttribute?(key: string, entity: EntityBase<TTable, TRelations>, value: unknown): unknown
  serializeEntity?(entity: EntityBase<TTable, TRelations>): ModelRecord<TTable>
  saveEntity?(entity: EntityBase<TTable, TRelations>): Promise<EntityBase<TTable, TRelations>>
  saveEntityQuietly?(entity: EntityBase<TTable, TRelations>): Promise<EntityBase<TTable, TRelations>>
  deleteEntity?(entity: EntityBase<TTable, TRelations>): Promise<void>
  deleteEntityQuietly?(entity: EntityBase<TTable, TRelations>): Promise<void>
  shouldKeepEntityPersistedOnDelete?(entity: EntityBase<TTable, TRelations>): boolean
  restoreEntity?(entity: EntityBase<TTable, TRelations>): Promise<EntityBase<TTable, TRelations>>
  restoreEntityQuietly?(entity: EntityBase<TTable, TRelations>): Promise<EntityBase<TTable, TRelations>>
  forceDeleteEntity?(entity: EntityBase<TTable, TRelations>): Promise<void>
  forceDeleteEntityQuietly?(entity: EntityBase<TTable, TRelations>): Promise<void>
  freshEntity?(entity: EntityBase<TTable, TRelations>): Promise<EntityBase<TTable, TRelations> | undefined>
  refreshEntity?(entity: EntityBase<TTable, TRelations>): Promise<EntityBase<TTable, TRelations>>
  replicateEntity?(entity: EntityBase<TTable, TRelations>, except: readonly string[]): EntityBase<TTable, TRelations>
  loadRelations?(
    items: readonly EntityBase<TTable, TRelations>[],
    relations: readonly ModelRelationPath<TRelations>[],
    missingOnly: boolean,
  ): Promise<void>
  loadMorphRelations?(
    items: readonly EntityBase<TTable, TRelations>[],
    relation: ModelRelationName<TRelations>,
    mapping: ModelMorphLoadMap,
  ): Promise<void>
  loadRelationAggregates?(items: readonly EntityBase<TTable, TRelations>[], aggregates: readonly ModelAggregateLoad[]): Promise<void>
  associateRelation?<TRelated extends TableDefinition>(entity: EntityBase<TTable, TRelations>, relation: string, related: EntityBase<TRelated> | null): void
  dissociateRelation?(entity: EntityBase<TTable, TRelations>, relation: string): void
  saveRelatedEntity?<TRelated extends TableDefinition>(entity: EntityBase<TTable, TRelations>, relation: string, related: EntityBase<TRelated>): Promise<EntityBase<TRelated>>
  saveManyRelatedEntities?<TRelated extends TableDefinition>(entity: EntityBase<TTable, TRelations>, relation: string, related: readonly EntityBase<TRelated>[]): Promise<EntityBase<TRelated>[]>
  saveRelatedEntityQuietly?<TRelated extends TableDefinition>(entity: EntityBase<TTable, TRelations>, relation: string, related: EntityBase<TRelated>): Promise<EntityBase<TRelated>>
  saveManyRelatedEntitiesQuietly?<TRelated extends TableDefinition>(entity: EntityBase<TTable, TRelations>, relation: string, related: readonly EntityBase<TRelated>[]): Promise<EntityBase<TRelated>[]>
  createRelatedEntity?<TRelated extends TableDefinition>(entity: EntityBase<TTable, TRelations>, relation: string, values: Record<string, unknown>): Promise<EntityBase<TRelated>>
  createManyRelatedEntities?<TRelated extends TableDefinition>(entity: EntityBase<TTable, TRelations>, relation: string, values: readonly Record<string, unknown>[]): Promise<EntityBase<TRelated>[]>
  createRelatedEntityQuietly?<TRelated extends TableDefinition>(entity: EntityBase<TTable, TRelations>, relation: string, values: Record<string, unknown>): Promise<EntityBase<TRelated>>
  createManyRelatedEntitiesQuietly?<TRelated extends TableDefinition>(entity: EntityBase<TTable, TRelations>, relation: string, values: readonly Record<string, unknown>[]): Promise<EntityBase<TRelated>[]>
  attachRelation?(entity: EntityBase<TTable, TRelations>, relation: string, ids: unknown, attributes: Record<string, unknown>): Promise<void>
  detachRelation?(entity: EntityBase<TTable, TRelations>, relation: string, ids?: unknown): Promise<number>
  syncRelation?(entity: EntityBase<TTable, TRelations>, relation: string, ids: unknown, detaching: boolean): Promise<{ attached: unknown[], detached: unknown[], updated: unknown[] }>
  updateExistingPivot?(entity: EntityBase<TTable, TRelations>, relation: string, id: unknown, attributes: Record<string, unknown>): Promise<number>
  toggleRelation?(entity: EntityBase<TTable, TRelations>, relation: string, ids: unknown): Promise<{ attached: unknown[], detached: unknown[] }>
  getRelationDefinition?(name: string): { kind: string }
  getRelationNames?(): readonly string[]
  resolveRelationProperty?(entity: EntityBase<TTable>, key: string): unknown
}

class EntityBase<
  TTable extends TableDefinition = TableDefinition,
  TRelations extends RelationMap = RelationMap,
> {
  private attributes: Record<string, unknown>
  private original: Record<string, unknown>
  private changes: Record<string, unknown>
  private persisted: boolean
  private relations: Record<string, unknown>
  private relationLoads = new Map<string, Promise<unknown>>()
  private peerCollection?: readonly EntityBase<TTable, TRelations>[]
  private hiddenOverrides = new Set<string>()
  private visibleOverrides = new Set<string>()
  private visibleOnly: string[] | null = null
  private appendedOverrides: string[] | null = null

  constructor(
    private readonly repository: ModelRepositoryLike<TTable, EmptyScopeMap, TRelations>,
    attributes: Partial<ModelRecord<TTable>>,
    exists = true,
  ) {
    this.attributes = { ...attributes }
    this.original = exists ? { ...attributes } : {}
    this.changes = exists ? {} : { ...attributes }
    this.persisted = exists
    this.relations = {}
    this.initializeModelProperties()
  }

  getRepository(): ModelRepositoryLike<TTable> {
    return this.repository
  }

  private getRepositoryRuntime(): EntityRepositoryRuntime<TTable, TRelations> {
    return this.repository as EntityRepositoryRuntime<TTable, TRelations>
  }

  is(other: unknown): boolean {
    if (!(other instanceof EntityBase)) {
      return false
    }

    const thisRepository = this.getRepositoryRuntime()
    const otherRepository = other.getRepository() as EntityRepositoryRuntime<TableDefinition, RelationMap>
    const thisKey = this.attributes[thisRepository?.definition?.primaryKey]
    const otherKey = other.toAttributes()[otherRepository?.definition?.primaryKey]

    return Boolean(
      thisRepository?.definition?.table?.tableName
      && thisRepository?.getConnection?.()
      && otherRepository?.definition?.table?.tableName
      && otherRepository?.getConnection?.()
      && thisKey !== null
      && typeof thisKey !== 'undefined'
      && otherKey !== null
      && typeof otherKey !== 'undefined'
      && thisRepository.definition.table.tableName === otherRepository.definition.table.tableName
      && thisRepository.getConnection().getConnectionName() === otherRepository.getConnection().getConnectionName()
      && thisKey === otherKey,
    )
  }

  isNot(other: unknown): boolean {
    return !this.is(other)
  }

  exists(): boolean {
    return this.persisted
  }

  trashed(): boolean {
    const repo = this.getRepositoryRuntime()
    const column = typeof repo.getDeletedAtColumn === 'function' ? repo.getDeletedAtColumn() : undefined
    if (!column) {
      return false
    }

    return this.attributes[column] !== null && typeof this.attributes[column] !== 'undefined'
  }

  get<TKey extends Extract<keyof ModelRecord<TTable>, string>>(key: TKey): ModelRecord<TTable>[TKey] {
    const repo = this.getRepositoryRuntime()
    const hasAttribute = Object.prototype.hasOwnProperty.call(this.attributes, key)
    if (!hasAttribute && typeof repo.shouldPreventAccessingMissingAttributes === 'function' && repo.shouldPreventAccessingMissingAttributes(key)) {
      throw new HydrationError(`Attribute "${String(key)}" is missing from model "${repo.definition.name}".`)
    }

    const value = typeof repo.resolveAttribute === 'function'
      ? repo.resolveAttribute(key, this, this.attributes[key])
      : this.attributes[key]
    return value as ModelRecord<TTable>[TKey]
  }

  set<TKey extends Extract<keyof ModelRecord<TTable>, string>>(key: TKey, value: ModelRecord<TTable>[TKey]): this {
    this.attributes[key] = value
    return this
  }

  fill(values: Partial<ModelRecord<TTable>>): this {
    Object.assign(this.attributes, values)
    return this
  }

  forceFill(values: Partial<ModelRecord<TTable>>): this {
    Object.assign(this.attributes, values)
    return this
  }

  isDirty(key?: Extract<keyof ModelRecord<TTable>, string>): boolean {
    if (key) {
      return !valuesAreEqual(this.attributes[key], this.original[key])
    }

    return Object.keys(this.getDirty()).length > 0
  }

  isClean(): boolean {
    return !this.isDirty()
  }

  getDirty(): Partial<ModelUpdatePayload<TTable>> {
    return Object.fromEntries(
      Object.entries(this.attributes).filter(([key, value]) => !valuesAreEqual(this.original[key], value)),
    ) as Partial<ModelUpdatePayload<TTable>>
  }

  getChanges(): Partial<ModelUpdatePayload<TTable>> {
    return { ...this.changes } as Partial<ModelUpdatePayload<TTable>>
  }

  wasChanged(key?: Extract<keyof ModelRecord<TTable>, string>): boolean {
    if (key) {
      return Object.prototype.hasOwnProperty.call(this.changes, key)
    }

    return Object.keys(this.changes).length > 0
  }

  syncOriginal(): this {
    this.original = { ...this.attributes }
    return this
  }

  syncChanges(): this {
    this.changes = { ...this.getDirty() }
    return this
  }

  syncPersisted(
    entity: EntityBase<TTable>,
    changes: Record<string, unknown> = {},
  ): this {
    this.attributes = { ...entity.toAttributes() }
    this.original = { ...entity.toAttributes() }
    this.changes = { ...changes }
    this.persisted = true
    return this
  }

  bindPeerCollection(peers: readonly EntityBase<TTable, TRelations>[]): this {
    this.peerCollection = peers
    return this
  }

  getPeerCollection(): readonly EntityBase<TTable, TRelations>[] | undefined {
    return this.peerCollection
  }

  getPendingRelationLoad(name: string): Promise<unknown> | undefined {
    return this.relationLoads.get(name)
  }

  setPendingRelationLoad(name: string, load: Promise<unknown>): this {
    this.relationLoads.set(name, load)
    return this
  }

  clearPendingRelationLoad(name: string): this {
    this.relationLoads.delete(name)
    return this
  }

  toAttributes(): ModelRecord<TTable> {
    return { ...this.attributes } as ModelRecord<TTable>
  }

  setRelation(name: string, value: unknown): this {
    this.relations[name] = value
    return this
  }

  setComputed(name: string, value: unknown): this {
    this.attributes[name] = value
    return this
  }

  makeHidden(...keys: readonly string[]): this {
    for (const key of keys) {
      this.hiddenOverrides.add(key)
      this.visibleOverrides.delete(key)
    }

    return this
  }

  makeVisible(...keys: readonly string[]): this {
    for (const key of keys) {
      this.visibleOverrides.add(key)
      this.hiddenOverrides.delete(key)
    }

    return this
  }

  setHidden(keys: readonly string[]): this {
    this.hiddenOverrides = new Set(keys)
    this.visibleOverrides.clear()
    this.visibleOnly = null
    return this
  }

  setVisible(keys: readonly string[]): this {
    this.visibleOnly = [...keys]
    this.hiddenOverrides.clear()
    this.visibleOverrides = new Set(keys)
    return this
  }

  append(...keys: readonly string[]): this {
    const next = this.appendedOverrides ?? []
    this.appendedOverrides = [...new Set([...next, ...keys])]
    return this
  }

  setAppends(keys: readonly string[]): this {
    this.appendedOverrides = [...keys]
    return this
  }

  withoutAppends(): this {
    this.appendedOverrides = []
    return this
  }

  getRelation<TRelation = unknown>(name: string): TRelation {
    return this.relations[name] as TRelation
  }

  hasRelation(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.relations, name)
  }

  getLoadedRelations(): Readonly<Record<string, unknown>> {
    return { ...this.relations }
  }

  getSerializationConfig(): {
    readonly hidden: ReadonlySet<string>
    readonly visible: ReadonlySet<string>
    readonly visibleOnly: readonly string[] | null
    readonly appended: readonly string[] | null
  } {
    return {
      hidden: this.hiddenOverrides,
      visible: this.visibleOverrides,
      visibleOnly: this.visibleOnly,
      appended: this.appendedOverrides,
    }
  }

  forgetRelation(name: string): this {
    Reflect.deleteProperty(this.relations, name)
    return this
  }

  toJSON(): ModelRecord<TTable> {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.serializeEntity === 'function') {
      return repo.serializeEntity(this) as ModelRecord<TTable>
    }

    return this.toAttributes()
  }

  async save(): Promise<this> {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.saveEntity !== 'function') {
      throw new HydrationError('The bound repository cannot persist entities.')
    }

    const pendingChanges = this.persisted ? this.getDirty() : this.toAttributes()
    const persisted = await repo.saveEntity(this)
    this.attributes = { ...persisted.toAttributes() }
    this.original = { ...persisted.toAttributes() }
    this.changes = { ...pendingChanges }
    this.persisted = true
    return this
  }

  async push(): Promise<this> {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.getRelationDefinition !== 'function') {
      throw new HydrationError('The bound repository cannot inspect relations for push().')
    }
    const getRelationDefinition = repo.getRelationDefinition.bind(repo)

    const parentRelations = Object.entries(this.relations)
      .filter(([name]) => {
        const relation = getRelationDefinition(name)
        return relation.kind === 'belongsTo' || relation.kind === 'morphTo'
      })

    for (const [relationName, value] of parentRelations) {
      if (isEntity(value)) {
        await value.save()
        await this.saveRelated(relationName, value)
      }
    }

    await this.save()

    const childRelations = Object.entries(this.relations)
      .filter(([name]) => {
        const relation = getRelationDefinition(name)
        return relation.kind !== 'belongsTo' && relation.kind !== 'morphTo'
      })

    for (const [relationName, value] of childRelations) {
      if (isEntity(value)) {
        await this.saveRelated(relationName, value)
        continue
      }

      if (Array.isArray(value)) {
        const relatedEntities = value.filter(isEntity)
        if (relatedEntities.length > 0) {
          const saved = await this.saveManyRelated(relationName, relatedEntities)
          this.setRelation(relationName, saved)
        }
      }
    }

    return this
  }

  async saveQuietly(): Promise<this> {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.saveEntityQuietly !== 'function') {
      throw new HydrationError('The bound repository cannot persist entities quietly.')
    }

    const pendingChanges = this.persisted ? this.getDirty() : this.toAttributes()
    const persisted = await repo.saveEntityQuietly(this)
    this.attributes = { ...persisted.toAttributes() }
    this.original = { ...persisted.toAttributes() }
    this.changes = { ...pendingChanges }
    this.persisted = true
    return this
  }

  async delete(): Promise<void> {
    if (!this.persisted) {
      throw new HydrationError('Cannot delete an entity that has not been persisted yet.')
    }

    const repo = this.getRepositoryRuntime()
    if (typeof repo.deleteEntity !== 'function') {
      throw new HydrationError('The bound repository cannot delete entities.')
    }

    await repo.deleteEntity(this)
    this.persisted = typeof repo.shouldKeepEntityPersistedOnDelete === 'function'
      ? repo.shouldKeepEntityPersistedOnDelete(this)
      : false
  }

  async deleteQuietly(): Promise<void> {
    if (!this.persisted) {
      throw new HydrationError('Cannot delete an entity that has not been persisted yet.')
    }

    const repo = this.getRepositoryRuntime()
    if (typeof repo.deleteEntityQuietly !== 'function') {
      throw new HydrationError('The bound repository cannot delete entities quietly.')
    }

    await repo.deleteEntityQuietly(this)
    this.persisted = typeof repo.shouldKeepEntityPersistedOnDelete === 'function'
      ? repo.shouldKeepEntityPersistedOnDelete(this)
      : false
  }

  async restore(): Promise<this> {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.restoreEntity !== 'function') {
      throw new HydrationError('The bound repository cannot restore entities.')
    }

    const restored = await repo.restoreEntity(this)
    this.attributes = { ...restored.toAttributes() }
    this.original = { ...restored.toAttributes() }
    this.changes = { ...restored.getChanges() }
    this.persisted = true
    return this
  }

  async restoreQuietly(): Promise<this> {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.restoreEntityQuietly !== 'function') {
      throw new HydrationError('The bound repository cannot restore entities quietly.')
    }

    const restored = await repo.restoreEntityQuietly(this)
    this.attributes = { ...restored.toAttributes() }
    this.original = { ...restored.toAttributes() }
    this.changes = { ...restored.getChanges() }
    this.persisted = true
    return this
  }

  async forceDelete(): Promise<void> {
    if (!this.persisted) {
      throw new HydrationError('Cannot force-delete an entity that has not been persisted yet.')
    }

    const repo = this.getRepositoryRuntime()
    if (typeof repo.forceDeleteEntity !== 'function') {
      throw new HydrationError('The bound repository cannot force-delete entities.')
    }

    await repo.forceDeleteEntity(this)
    this.persisted = false
  }

  async forceDeleteQuietly(): Promise<void> {
    if (!this.persisted) {
      throw new HydrationError('Cannot force-delete an entity that has not been persisted yet.')
    }

    const repo = this.getRepositoryRuntime()
    if (typeof repo.forceDeleteEntityQuietly !== 'function') {
      throw new HydrationError('The bound repository cannot force-delete entities quietly.')
    }

    await repo.forceDeleteEntityQuietly(this)
    this.persisted = false
  }

  async fresh(): Promise<Entity<TTable, TRelations> | undefined> {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.freshEntity !== 'function') {
      throw new HydrationError('The bound repository cannot refresh entities.')
    }

    return repo.freshEntity(this) as Promise<Entity<TTable, TRelations> | undefined>
  }

  async refresh(): Promise<this> {
    if (!this.persisted) {
      throw new HydrationError('Cannot refresh an entity that has not been persisted yet.')
    }

    const repo = this.getRepositoryRuntime()
    if (typeof repo.refreshEntity !== 'function') {
      throw new HydrationError('The bound repository cannot refresh entities.')
    }

    const refreshed = await repo.refreshEntity(this)
    this.attributes = { ...refreshed.toAttributes() }
    this.original = { ...refreshed.toAttributes() }
    this.changes = {}
    this.relations = {}
    this.persisted = true
    return this
  }

  replicate(except: readonly string[] = []): Entity<TTable, TRelations> {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.replicateEntity !== 'function') {
      throw new HydrationError('The bound repository cannot replicate entities.')
    }

    return repo.replicateEntity(this, except) as Entity<TTable, TRelations>
  }

  async load<TPaths extends readonly ModelRelationPath<TRelations>[]>(
    ...relations: TPaths
  ): Promise<
    this
    & ResolveEagerLoads<TRelations, TPaths>
    & (this extends { toJSON(): infer R }
      ? { toJSON(): R & SerializeLoaded<ResolveEagerLoads<TRelations, TPaths>> }
      : { toJSON(): ModelRecord<TTable> & SerializeLoaded<ResolveEagerLoads<TRelations, TPaths>> })
  > {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.loadRelations !== 'function') {
      throw new HydrationError('The bound repository cannot load relations.')
    }

    await repo.loadRelations([this], relations, false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- widened return merges this + new loads
    return this as any
  }

  async loadMissing<TPaths extends readonly ModelRelationPath<TRelations>[]>(
    ...relations: TPaths
  ): Promise<
    this
    & ResolveEagerLoads<TRelations, TPaths>
    & (this extends { toJSON(): infer R }
      ? { toJSON(): R & SerializeLoaded<ResolveEagerLoads<TRelations, TPaths>> }
      : { toJSON(): ModelRecord<TTable> & SerializeLoaded<ResolveEagerLoads<TRelations, TPaths>> })
  > {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.loadRelations !== 'function') {
      throw new HydrationError('The bound repository cannot load relations.')
    }

    await repo.loadRelations([this], relations, true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- widened return merges this + new loads
    return this as any
  }

  async loadMorph(
    relation: ModelRelationName<TRelations>,
    mapping: ModelMorphLoadMap,
  ): Promise<this> {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.loadMorphRelations !== 'function') {
      throw new HydrationError('The bound repository cannot load morph relations.')
    }

    await repo.loadMorphRelations([this], relation, mapping)
    return this
  }

  async loadCount(...relations: readonly ModelRelationName<TRelations>[]): Promise<this> {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.loadRelationAggregates !== 'function') {
      throw new HydrationError('The bound repository cannot load relation aggregates.')
    }

    await repo.loadRelationAggregates([this], relations.map(relation => ({ relation, kind: 'count' })))
    return this
  }

  async loadExists(...relations: readonly ModelRelationName<TRelations>[]): Promise<this> {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.loadRelationAggregates !== 'function') {
      throw new HydrationError('The bound repository cannot load relation aggregates.')
    }

    await repo.loadRelationAggregates([this], relations.map(relation => ({ relation, kind: 'exists' })))
    return this
  }

  async loadSum<TRelationName extends ModelRelationName<TRelations>>(relation: TRelationName, column: RelatedColumnNameOfRelation<TRelations[TRelationName]>): Promise<this> {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.loadRelationAggregates !== 'function') {
      throw new HydrationError('The bound repository cannot load relation aggregates.')
    }

    await repo.loadRelationAggregates([this], [{ relation, kind: 'sum', column }])
    return this
  }

  async loadAvg<TRelationName extends ModelRelationName<TRelations>>(relation: TRelationName, column: RelatedColumnNameOfRelation<TRelations[TRelationName]>): Promise<this> {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.loadRelationAggregates !== 'function') {
      throw new HydrationError('The bound repository cannot load relation aggregates.')
    }

    await repo.loadRelationAggregates([this], [{ relation, kind: 'avg', column }])
    return this
  }

  async loadMin<TRelationName extends ModelRelationName<TRelations>>(relation: TRelationName, column: RelatedColumnNameOfRelation<TRelations[TRelationName]>): Promise<this> {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.loadRelationAggregates !== 'function') {
      throw new HydrationError('The bound repository cannot load relation aggregates.')
    }

    await repo.loadRelationAggregates([this], [{ relation, kind: 'min', column }])
    return this
  }

  async loadMax<TRelationName extends ModelRelationName<TRelations>>(relation: TRelationName, column: RelatedColumnNameOfRelation<TRelations[TRelationName]>): Promise<this> {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.loadRelationAggregates !== 'function') {
      throw new HydrationError('The bound repository cannot load relation aggregates.')
    }

    await repo.loadRelationAggregates([this], [{ relation, kind: 'max', column }])
    return this
  }

  associate<TRelated extends TableDefinition>(relation: string, related: Entity<TRelated> | null): this {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.associateRelation !== 'function') {
      throw new HydrationError('The bound repository cannot associate relations.')
    }

    repo.associateRelation(this, relation, related)
    return this
  }

  dissociate(relation: string): this {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.dissociateRelation !== 'function') {
      throw new HydrationError('The bound repository cannot dissociate relations.')
    }

    repo.dissociateRelation(this, relation)
    return this
  }

  async saveRelated<TRelated extends TableDefinition>(relation: string, related: Entity<TRelated>): Promise<Entity<TRelated>> {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.saveRelatedEntity !== 'function') {
      throw new HydrationError('The bound repository cannot persist related models.')
    }

    return repo.saveRelatedEntity(this, relation, related) as Promise<Entity<TRelated>>
  }

  async saveManyRelated<TRelated extends TableDefinition>(relation: string, related: readonly Entity<TRelated>[]): Promise<Entity<TRelated>[]> {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.saveManyRelatedEntities !== 'function') {
      throw new HydrationError('The bound repository cannot persist related models.')
    }

    return repo.saveManyRelatedEntities(this, relation, related) as Promise<Entity<TRelated>[]>
  }

  async saveRelatedQuietly<TRelated extends TableDefinition>(relation: string, related: Entity<TRelated>): Promise<Entity<TRelated>> {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.saveRelatedEntityQuietly !== 'function') {
      throw new HydrationError('The bound repository cannot persist related models quietly.')
    }

    return repo.saveRelatedEntityQuietly(this, relation, related) as Promise<Entity<TRelated>>
  }

  async saveManyRelatedQuietly<TRelated extends TableDefinition>(relation: string, related: readonly Entity<TRelated>[]): Promise<Entity<TRelated>[]> {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.saveManyRelatedEntitiesQuietly !== 'function') {
      throw new HydrationError('The bound repository cannot persist related models quietly.')
    }

    return repo.saveManyRelatedEntitiesQuietly(this, relation, related) as Promise<Entity<TRelated>[]>
  }

  async createRelated(
    relation: string,
    values: Record<string, unknown>,
  ): Promise<Entity<TableDefinition>> {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.createRelatedEntity !== 'function') {
      throw new HydrationError('The bound repository cannot create related models.')
    }

    return repo.createRelatedEntity(this, relation, values) as Promise<Entity<TableDefinition>>
  }

  async createManyRelated(
    relation: string,
    values: readonly Record<string, unknown>[],
  ): Promise<Entity<TableDefinition>[]> {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.createManyRelatedEntities !== 'function') {
      throw new HydrationError('The bound repository cannot create related models.')
    }

    return repo.createManyRelatedEntities(this, relation, values) as Promise<Entity<TableDefinition>[]>
  }

  async createRelatedQuietly(
    relation: string,
    values: Record<string, unknown>,
  ): Promise<Entity<TableDefinition>> {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.createRelatedEntityQuietly !== 'function') {
      throw new HydrationError('The bound repository cannot create related models quietly.')
    }

    return repo.createRelatedEntityQuietly(this, relation, values) as Promise<Entity<TableDefinition>>
  }

  async createManyRelatedQuietly(
    relation: string,
    values: readonly Record<string, unknown>[],
  ): Promise<Entity<TableDefinition>[]> {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.createManyRelatedEntitiesQuietly !== 'function') {
      throw new HydrationError('The bound repository cannot create related models quietly.')
    }

    return repo.createManyRelatedEntitiesQuietly(this, relation, values) as Promise<Entity<TableDefinition>[]>
  }

  async attach(
    relation: string,
    ids: unknown,
    attributes: Record<string, unknown> = {},
  ): Promise<void> {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.attachRelation !== 'function') {
      throw new HydrationError('The bound repository cannot mutate many-to-many relations.')
    }

    await repo.attachRelation(this, relation, ids, attributes)
    this.forgetRelation(relation)
  }

  async detach(relation: string, ids?: unknown): Promise<number> {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.detachRelation !== 'function') {
      throw new HydrationError('The bound repository cannot mutate many-to-many relations.')
    }

    const detached = await repo.detachRelation(this, relation, ids)
    this.forgetRelation(relation)
    return detached
  }

  async sync(relation: string, ids: unknown): Promise<{ attached: unknown[], detached: unknown[], updated: unknown[] }> {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.syncRelation !== 'function') {
      throw new HydrationError('The bound repository cannot mutate many-to-many relations.')
    }

    const result = await repo.syncRelation(this, relation, ids, true)
    this.forgetRelation(relation)
    return result
  }

  async syncWithoutDetaching(
    relation: string,
    ids: unknown,
  ): Promise<{ attached: unknown[], detached: unknown[], updated: unknown[] }> {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.syncRelation !== 'function') {
      throw new HydrationError('The bound repository cannot mutate many-to-many relations.')
    }

    const result = await repo.syncRelation(this, relation, ids, false)
    this.forgetRelation(relation)
    return result
  }

  async updateExistingPivot(
    relation: string,
    id: unknown,
    attributes: Record<string, unknown>,
  ): Promise<number> {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.updateExistingPivot !== 'function') {
      throw new HydrationError('The bound repository cannot mutate many-to-many relations.')
    }

    const updated = await repo.updateExistingPivot(this, relation, id, attributes)
    this.forgetRelation(relation)
    return updated
  }

  async toggle(relation: string, ids: unknown): Promise<{ attached: unknown[], detached: unknown[] }> {
    const repo = this.getRepositoryRuntime()
    if (typeof repo.toggleRelation !== 'function') {
      throw new HydrationError('The bound repository cannot mutate many-to-many relations.')
    }

    const result = await repo.toggleRelation(this, relation, ids)
    this.forgetRelation(relation)
    return result
  }

  private initializeModelProperties(): void {
    const repo = this.getRepositoryRuntime()
    const columns = repo?.definition?.table?.columns
    if (columns && typeof columns === 'object') {
      for (const key of Object.keys(columns)) {
        if (key in this) {
          continue
        }

        Object.defineProperty(this, key, {
          configurable: true,
          enumerable: true,
          get: () => this.get(key as never),
          set: (value: unknown) => {
            this.set(key as never, value as never)
          },
        })
      }
    }

    const relationNames = typeof repo?.getRelationNames === 'function'
      ? repo.getRelationNames()
      : Object.keys(repo?.definition?.relations ?? {})

    for (const key of relationNames) {
      if (key in this) {
        continue
      }

      Object.defineProperty(this, key, {
        configurable: true,
        enumerable: false,
        get: () => {
          if (this.hasRelation(key)) {
            return this.getRelation(key)
          }

          if (typeof repo?.resolveRelationProperty === 'function') {
            return repo.resolveRelationProperty(this, key)
          }

          return undefined
        },
        set: (value: unknown) => {
          this.setRelation(key, value)
        },
      })
    }
  }
}

export type Entity<
  TTable extends TableDefinition = TableDefinition,
  TRelations extends RelationMap = RelationMap,
> = EntityBase<TTable, TRelations> & ModelRecord<TTable>

export const Entity = EntityBase as unknown as EntityConstructor
