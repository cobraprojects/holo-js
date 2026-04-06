import { Factory } from './Factory'
import type { FactoryDefinition, FactoryModelReference } from './types'

export function defineFactory<TModel extends FactoryModelReference>(
  model: TModel,
  definition: FactoryDefinition<TModel>,
): Factory<TModel> {
  return new Factory(model, definition)
}
