import type { LogicalColumnKind } from '../schema/types'
import type {
  AggregateKeyParts,
  AggregateRelatedColumnNameOfKeys,
  AggregateRelationConstraintMap,
  AggregateRelationName,
  ModelRelationName,
  RelatedColumnNameOfRelation,
  RelatedTableOfRelation,
  RelationAggregateKind,
  RelationConstraintFor,
  RelationMap,
  RelationNameConstraintMapGuarded,
} from './types'

type RowAggregate = 'count' | 'exists'
type ColumnAggregate = Exclude<RelationAggregateKind, RowAggregate>

type Extremum<TKind extends LogicalColumnKind>
  = TKind extends 'string' | 'text' ? string
    : TKind extends 'date' | 'datetime' | 'timestamp' ? Date
      : number

type ColumnKind<TRelations extends RelationMap, TKey extends string, TColumn extends string>
  = RelatedTableOfRelation<TRelations[AggregateRelationName<TKey>]>['columns'] extends infer TColumns
    ? TColumn extends keyof TColumns
      ? TColumns[TColumn] extends { readonly kind: infer TKind extends LogicalColumnKind } ? TKind : LogicalColumnKind
      : LogicalColumnKind
    : LogicalColumnKind

type AggregateValue<TRelations extends RelationMap, TKind extends RelationAggregateKind, TKey extends string, TColumn extends string>
  = TKind extends 'count' | 'sum' ? number
    : TKind extends 'exists' ? boolean
      : TKind extends 'avg' ? number | null
        : Extremum<ColumnKind<TRelations, TKey, TColumn>> | null

type AggregateKey<TKey extends string, TKind extends RelationAggregateKind, TColumn extends string>
  = string extends TKey ? never
    : AggregateKeyParts<TKey> extends { readonly alias: infer TAlias extends string }
      ? string extends TAlias ? never : TAlias
      : TKind extends RowAggregate ? `${AggregateRelationName<TKey>}_${TKind}`
        : `${AggregateRelationName<TKey>}_${TKind}_${TColumn}`

type AggregateAttribute<TRelations extends RelationMap, TKind extends RelationAggregateKind, TKey extends string, TColumn extends string>
  = TKey extends string
    ? TKind extends RelationAggregateKind
      ? TColumn extends string
        ? { readonly [K in AggregateKey<TKey, TKind, TColumn>]: AggregateValue<TRelations, TKind, TKey, TColumn> }
        : never
      : never
    : never

type TupleAttributes<TRelations extends RelationMap, TKind extends RelationAggregateKind, TColumn extends string, TNames extends readonly string[]>
  = TNames extends readonly [infer TFirst extends string, ...infer TRest extends readonly string[]]
    ? AggregateAttribute<TRelations, TKind, TFirst, TColumn> & TupleAttributes<TRelations, TKind, TColumn, TRest>
    : { readonly [K in TNames[number] as AggregateKey<K, TKind, TColumn>]?: AggregateValue<TRelations, TKind, K, TColumn> }

export type RelationAggregateAttributes<
  TRelations extends RelationMap,
  TKind extends RelationAggregateKind,
  TInput,
  TColumn extends string = '*',
  TRest extends readonly string[] = [],
> = TKind extends RelationAggregateKind
  ? TColumn extends string
    ? TInput extends readonly string[] ? TupleAttributes<TRelations, TKind, TColumn, TInput>
      : TInput extends string ? AggregateAttribute<TRelations, TKind, TInput, TColumn> & TupleAttributes<TRelations, TKind, TColumn, TRest>
        : { readonly [K in keyof TInput as K extends string ? AggregateKey<K, TKind, TColumn> : never]: AggregateValue<TRelations, TKind, Extract<K, string>, TColumn> }
    : never
  : never

export interface RelationAggregateQueryResult {
  readonly attributes: unknown
  readonly query: unknown
}

type AggregateResult<TTarget extends RelationAggregateQueryResult, TRelations extends RelationMap, TKind extends RelationAggregateKind, TInput, TColumn extends string = '*', TRest extends readonly string[] = []>
  = (TTarget & { readonly attributes: RelationAggregateAttributes<TRelations, TKind, TInput, TColumn, TRest> })['query']

type ValidRelation<TRelations extends RelationMap, TKey extends string>
  = [AggregateRelationName<TKey>] extends [ModelRelationName<TRelations>] ? unknown : never

type KeysOf<T> = T extends unknown ? keyof T : never

type AggregateInputKeys<TInput> = TInput extends string ? TInput : `${Extract<keyof TInput, string | number>}`

type ValidMixedAggregateInput<TRelations extends RelationMap, TInput>
  = [Extract<TInput, string>] extends [never] ? never
    : [Exclude<TInput, string>] extends [AggregateRelationConstraintMap<TRelations, AggregateInputKeys<Exclude<TInput, string>>>]
      ? ValidRelation<TRelations, AggregateInputKeys<TInput>>
      : never

type ConstraintColumns<TRelations extends RelationMap, TConstraints>
  = AggregateRelatedColumnNameOfKeys<TRelations, `${Extract<KeysOf<TConstraints>, string | number>}`>

type AggregateConstraints<TRelations extends RelationMap, TKey extends string> = {
  readonly [K in TKey]: RelationConstraintFor<TRelations, AggregateRelationName<K>>
}

type RowAggregateMethod<TRelations extends RelationMap, TTarget extends RelationAggregateQueryResult, TKind extends RowAggregate, TRelationNames extends readonly string[]> = {
  <const TNames extends TRelationNames>(...relations: TNames): AggregateResult<TTarget, TRelations, TKind, TNames>
  <TConstraints extends RelationNameConstraintMapGuarded<TRelations, TConstraints>>(relations: TConstraints): AggregateResult<TTarget, TRelations, TKind, TConstraints>
  <TKey extends string, TInput extends object>(relations: AggregateConstraints<TRelations, TKey> & TInput & ValidRelation<TRelations, NoInfer<AggregateInputKeys<TInput>>>): AggregateResult<TTarget, TRelations, TKind, TInput>
}

type ColumnAggregateMethod<TRelations extends RelationMap, TTarget extends RelationAggregateQueryResult, TKind extends ColumnAggregate> = {
  <TKey extends string, TColumn extends AggregateRelatedColumnNameOfKeys<TRelations, NoInfer<TKey>> = AggregateRelatedColumnNameOfKeys<TRelations, TKey>, const TRest extends readonly ModelRelationName<TRelations>[] = readonly ModelRelationName<TRelations>[]>(
    relation: TKey & ValidRelation<TRelations, TKey>,
    column: TColumn,
    ...rest: TRest
  ): AggregateResult<TTarget, TRelations, TKind, TKey, TColumn, TRest>
  <TKey extends string, TInput extends object, TColumn extends ConstraintColumns<TRelations, NoInfer<TInput>>>(
    relations: AggregateConstraints<TRelations, TKey> & TInput,
    column: TColumn,
    ...rest: readonly ModelRelationName<TRelations>[]
  ): AggregateResult<TTarget, TRelations, TKind, TInput, TColumn>
  <TInput extends AggregateRelationConstraintMap<TRelations, Extract<keyof TInput, string>>, _TNoExplicitArgument extends never, TColumn extends string>(
    relations: TInput,
    column: ConstraintColumns<TRelations, TInput> & TColumn,
    ...rest: readonly ModelRelationName<TRelations>[]
  ): AggregateResult<TTarget, TRelations, TKind, TInput, TColumn>
  <TKey extends string, TColumn extends string = AggregateRelatedColumnNameOfKeys<TRelations, TKey>>(
    relations: NoInfer<TKey> | AggregateRelationConstraintMap<TRelations, TKey>,
    column: AggregateRelatedColumnNameOfKeys<TRelations, TKey> & TColumn,
    ...rest: readonly ModelRelationName<TRelations>[]
  ): AggregateResult<TTarget, TRelations, TKind, AggregateRelationConstraintMap<TRelations, TKey>, TColumn>
  <TInput extends RelationNameConstraintMapGuarded<TRelations, TInput> & ([KeysOf<TInput>] extends [ModelRelationName<TRelations>] ? unknown : never), _TNoExplicitArgument extends never, TColumn extends string>(
    relations: TInput,
    column: RelatedColumnNameOfRelation<TRelations[ModelRelationName<TRelations>]> & TColumn,
    ...rest: readonly ModelRelationName<TRelations>[]
  ): AggregateResult<TTarget, TRelations, TKind, TInput, TColumn>
  <TInput extends string | object, TColumn extends AggregateRelatedColumnNameOfKeys<TRelations, AggregateInputKeys<TInput>>>(
    relations: TInput & ValidMixedAggregateInput<TRelations, TInput>,
    column: TColumn,
    ...rest: readonly ModelRelationName<TRelations>[]
  ): AggregateResult<TTarget, TRelations, TKind, TInput, TColumn>
}

type AggregateMethod<TRelations extends RelationMap, TTarget extends RelationAggregateQueryResult> = {
  <TKey extends string, TKind extends RowAggregate = RowAggregate>(
    relation: TKey & ValidRelation<TRelations, TKey>,
    column: '*',
    aggregate: TKind
  ): AggregateResult<TTarget, TRelations, TKind, TKey>
  <TKey extends string, TInput extends object, TKind extends RowAggregate>(
    relations: AggregateConstraints<TRelations, TKey> & TInput & ValidRelation<TRelations, NoInfer<AggregateInputKeys<TInput>>>,
    column: '*',
    aggregate: TKind
  ): AggregateResult<TTarget, TRelations, TKind, TInput>
  <TKey extends string, TColumn extends AggregateRelatedColumnNameOfKeys<TRelations, NoInfer<TKey>> = AggregateRelatedColumnNameOfKeys<TRelations, TKey>, TKind extends ColumnAggregate = ColumnAggregate>(
    relation: TKey & ValidRelation<TRelations, TKey>,
    column: TColumn,
    aggregate: TKind
  ): AggregateResult<TTarget, TRelations, TKind, TKey, TColumn>
  <TKey extends string, TInput extends object, TColumn extends ConstraintColumns<TRelations, NoInfer<TInput>>, TKind extends ColumnAggregate>(
    relations: AggregateConstraints<TRelations, TKey> & TInput,
    column: TColumn,
    aggregate: TKind
  ): AggregateResult<TTarget, TRelations, TKind, TInput, TColumn>
  <TKey extends string, TKind extends RowAggregate = RowAggregate>(
    relations: NoInfer<TKey | AggregateRelationConstraintMap<TRelations, TKey>> & ValidRelation<TRelations, TKey>,
    column: '*',
    aggregate: TKind
  ): AggregateResult<TTarget, TRelations, TKind, TKey | AggregateRelationConstraintMap<TRelations, TKey>>
  <TKey extends string, TColumn extends AggregateRelatedColumnNameOfKeys<TRelations, TKey> = AggregateRelatedColumnNameOfKeys<TRelations, TKey>, TKind extends ColumnAggregate = ColumnAggregate>(
    relations: NoInfer<TKey | AggregateRelationConstraintMap<TRelations, TKey>>,
    column: TColumn,
    aggregate: TKind
  ): AggregateResult<TTarget, TRelations, TKind, TKey | AggregateRelationConstraintMap<TRelations, TKey>, TColumn>
  <TInput extends string | object, TKind extends RowAggregate>(
    relations: TInput & ValidMixedAggregateInput<TRelations, TInput>,
    column: '*',
    aggregate: TKind
  ): AggregateResult<TTarget, TRelations, TKind, TInput>
  <TInput extends string | object, TColumn extends AggregateRelatedColumnNameOfKeys<TRelations, AggregateInputKeys<TInput>>, TKind extends ColumnAggregate>(
    relations: TInput & ValidMixedAggregateInput<TRelations, TInput>,
    column: TColumn,
    aggregate: TKind
  ): AggregateResult<TTarget, TRelations, TKind, TInput, TColumn>
}

export type RelationAggregateMethods<
  TRelations extends RelationMap,
  TTarget extends RelationAggregateQueryResult,
  TRelationNames extends readonly ModelRelationName<TRelations>[] = readonly ModelRelationName<TRelations>[],
> = { [K in RowAggregate as `with${Capitalize<K>}`]: RowAggregateMethod<TRelations, TTarget, K, TRelationNames> }
  & { [K in ColumnAggregate as `with${Capitalize<K>}`]: ColumnAggregateMethod<TRelations, TTarget, K> }
  & { withAggregate: AggregateMethod<TRelations, TTarget> }
