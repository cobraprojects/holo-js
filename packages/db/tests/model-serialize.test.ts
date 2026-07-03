import { describe, expect, it } from 'vitest'
import { serializeModels } from '../src/model/serialize'

describe('@holo-js/db model serialization helpers', () => {
  it('serializes model-like values recursively while preserving dates and primitives', () => {
    const createdAt = new Date('2026-06-30T01:00:00.000Z')
    const model = {
      toJSON() {
        return {
          id: 1,
          nested: {
            at: createdAt,
            values: [
              1,
              {
                toJSON() {
                  return { name: 'Ava' }
                },
              },
            ],
          },
        }
      },
    }

    expect(serializeModels({
      empty: null,
      model,
      raw: 'value',
    })).toEqual({
      empty: null,
      model: {
        id: 1,
        nested: {
          at: createdAt,
          values: [
            1,
            { name: 'Ava' },
          ],
        },
      },
      raw: 'value',
    })
  })

  it('keeps non-model objects and functions as normal serializable values', () => {
    const action = () => 'kept'

    expect(serializeModels({
      action,
      object: {
        toJSON: 'not a function',
      },
    })).toEqual({
      action,
      object: {
        toJSON: 'not a function',
      },
    })
  })
})
