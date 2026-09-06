import type { Entity, TableDefinition } from '@holo-js/db'
import { clearEntityMedia } from './entity'

const modelObserverRegistrar = Symbol.for('holo-js.db.model-observer-registrar')

type ModelObserverRegistrar = (observer: object) => void

type ObservableMediaModel = {
  readonly definition: {
    readonly softDeletes: boolean
  }
  readonly [modelObserverRegistrar]?: ModelObserverRegistrar
}

const deletingObserver = Object.freeze({
  deleting(entity: Entity<TableDefinition>) {
    return clearEntityMedia(entity)
  },
})

const forceDeletingObserver = Object.freeze({
  forceDeleting(entity: Entity<TableDefinition>) {
    return clearEntityMedia(entity)
  },
})

export function observeMediaModelDeletion(model: ObservableMediaModel): void {
  const registerObserver = model[modelObserverRegistrar]
  if (!registerObserver) {
    throw new Error('[Holo Media] The database model does not support internal observer registration.')
  }

  registerObserver(model.definition.softDeletes ? forceDeletingObserver : deletingObserver)
}
