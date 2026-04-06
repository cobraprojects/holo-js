import { DatabaseError } from '../core/errors'
import type { Factory } from './Factory'
import type { FactoryModelReference } from './types'

export class FactoryService {
  private readonly factories = new Map<string, Factory<FactoryModelReference>>()

  register<TModel extends FactoryModelReference>(name: string, factory: Factory<TModel>): this {
    const existing = this.factories.get(name)
    if (existing && existing !== (factory as unknown as Factory<FactoryModelReference>)) {
      throw new DatabaseError(`Factory "${name}" is already registered.`, 'DUPLICATE_FACTORY')
    }

    this.factories.set(name, factory as unknown as Factory<FactoryModelReference>)
    return this
  }

  get(name: string): Factory<FactoryModelReference> | undefined {
    return this.factories.get(name)
  }

  has(name: string): boolean {
    return this.factories.has(name)
  }

  list(): readonly Factory<FactoryModelReference>[] {
    return [...this.factories.values()]
  }

  clear(): void {
    this.factories.clear()
  }
}

export function createFactoryService(): FactoryService {
  return new FactoryService()
}
