import { areModelEventsMuted, areModelGuardsDisabled, withoutModelEvents, withoutModelGuards } from './eventState'

export class ModelEventService {
  areEventsMuted(): boolean {
    return areModelEventsMuted()
  }

  async withoutEvents<T>(callback: () => T | Promise<T>): Promise<T> {
    return withoutModelEvents(callback)
  }

  areGuardsDisabled(): boolean {
    return areModelGuardsDisabled()
  }

  async withoutGuards<T>(callback: () => T | Promise<T>): Promise<T> {
    return withoutModelGuards(callback)
  }
}

export function createModelEventService(): ModelEventService {
  return new ModelEventService()
}
