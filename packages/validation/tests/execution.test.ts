import { describe, expect, it } from 'vitest'
import { field, safeParse, schema } from '../src'

describe('Validation rule execution', () => {
  it('uses the same transformed value for output and following custom rules', async () => {
    let sequence = 0
    const definition = schema({
      value: field.string()
        .transform(value => ({ value, sequence: ++sequence }))
        .custom(value => value.sequence === 1),
    })

    const result = await safeParse({ value: 'Ava' }, definition)

    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.data.value).toEqual({ value: 'Ava', sequence: 1 })
    }
    expect(sequence).toBe(1)
  })

  it('applies defaults before transforms and custom rules through Standard Schema', async () => {
    const definition = field.string().required().default('Ava')
      .transform(value => value.length)
      .custom(value => value === 3)

    expect(await definition['~standard'].validate(undefined)).toEqual({ value: 3 })
  })

  it('preserves default and confirmation values when another field fails', async () => {
    const definition = schema({
      name: field.string().required().default('Ava').transform(value => value.length),
      password: field.string().transform(value => value.trim()).confirmed(),
      passwordConfirmation: field.string().transform(value => value.trim()),
      count: field.number(),
    })

    const result = await safeParse({ password: ' secret ', passwordConfirmation: ' secret ', count: 'bad' }, definition)

    expect(result.valid).toBe(false)
    expect(result.errors.flatten()).toEqual({ count: ['This field must be a number.'] })
  })

  it('skips typed callbacks after base failures and suppressed transforms', async () => {
    const values: string[] = []
    const definition = schema({
      wrongType: field.string().custom(value => { values.push(value); return true })
        .transform(value => value.length),
      tooShort: field.string().custom(() => 'Custom failure.')
        .min(3, 'Too short.')
        .transform(value => { values.push(value); return value.length })
        .custom(() => 'Suppressed failure.'),
    })

    const result = await safeParse({ wrongType: 42, tooShort: 'A' }, definition)

    expect(result.errors.flatten()).toEqual({
      wrongType: ['This field must be text.'],
      tooShort: ['Too short.', 'Custom failure.'],
    })
    expect(values).toEqual([])
  })

  it('continues rules after custom failures and retains null transform output', async () => {
    const values: (string | null)[] = []
    const definition = schema({
      value: field.string()
        .custom(value => { values.push(value); return 'Custom failure.' })
        .transform(() => null)
        .custom(value => { values.push(value); return 'Later failure.' }),
    })

    const result = await safeParse({ value: 'Ava' }, definition)

    expect(values).toEqual(['Ava', null])
    expect(result.errors.get('value')).toEqual(['Custom failure.', 'Later failure.'])
  })

  it('keeps nested array checks serial and isolated across overlapping validations', async () => {
    const values: string[] = []
    const definition = schema({
      rows: field.array({
        cells: field.array(field.string()
          .transform(value => ({ value }))
          .customAsync(async value => {
            values.push(`start:${value.value}`)
            await Promise.resolve()
            values.push(`end:${value.value}`)
            return value.value !== 'blocked' || 'Blocked cell.'
          })),
      }),
      tail: field.string().custom(value => { values.push(value); return true }),
    })

    const [first, second] = await Promise.all([
      safeParse({ rows: [{ cells: ['first', 'blocked'] }], tail: 'first-tail' }, definition),
      safeParse({ rows: [{ cells: ['second'] }], tail: 'second-tail' }, definition),
    ])

    expect(first.errors.flatten()).toEqual({ 'rows.0.cells.1': ['Blocked cell.'] })
    expect(second.valid).toBe(true)
    if (second.valid) expect(second.data.rows).toEqual([{ cells: [{ value: 'second' }] }])
    expect(values.filter(value => value.includes('first') || value.includes('blocked'))).toEqual([
      'start:first', 'end:first', 'start:blocked', 'end:blocked', 'first-tail',
    ])
    expect(values.filter(value => value.includes('second'))).toEqual(['start:second', 'end:second', 'second-tail'])
  })

  it('validates every child before a parent transform removes array entries', async () => {
    const definition = schema({
      rows: field.array(field.string().custom(value => value !== 'blocked' || 'Blocked row.'))
        .transform(values => values.slice(1)),
    })

    const result = await safeParse({ rows: ['blocked', 'allowed'] }, definition)

    expect(result.valid).toBe(false)
    expect(result.errors.flatten()).toEqual({ 'rows.0': ['Blocked row.'] })
  })

  it('keeps confirmation attached to its containing row after parent transforms', async () => {
    const row = {
      password: field.string().transform(value => value.trim()).confirmed(),
      passwordConfirmation: field.string().transform(value => value.trim()),
    }
    const input = { rows: [
      { password: ' first ', passwordConfirmation: ' first ' },
      { password: ' second ', passwordConfirmation: ' second ' },
    ] }
    const reordered = schema({ rows: field.array(row).transform(values => [...values].reverse()) })
    const reshaped = schema({ rows: field.array(row).transform(values => ({ records: values.slice(1) })) })

    const reorderedResult = await safeParse(input, reordered)
    const reshapedResult = await safeParse(input, reshaped)

    expect(reorderedResult.valid).toBe(true)
    if (reorderedResult.valid) expect(reorderedResult.data.rows.map(value => value.password)).toEqual(['second', 'first'])
    expect(reshapedResult.valid).toBe(true)
    if (reshapedResult.valid) expect(reshapedResult.data.rows.records).toEqual([{ password: 'second', passwordConfirmation: 'second' }])
  })

  it('checks confirmation inside nested arrays supplied by defaults', async () => {
    const rows = [{ password: 'different', passwordConfirmation: 'secret' }]
    const definition = schema({
      groups: field.array({
        rows: field.array({
          password: field.string().confirmed(),
          passwordConfirmation: field.string(),
        }).default(rows),
      }).default([{ rows }]),
    })

    for (const input of [{}, { groups: [{}] }]) {
      const result = await safeParse(input, definition)
      expect(result.valid).toBe(false)
      expect(result.errors.flatten()).toEqual({
        'groups.0.rows.0.password': ['This field does not match its confirmation.'],
      })
    }
  })
})
