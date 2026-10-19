import { describe, expect, it } from 'vitest'
import { ValidationException, field, safeParse, schema, validate, validationInternals, type ValidationSchema } from '../src'

const pngPixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

function formWith(entries: readonly (readonly [string, string])[]): FormData {
  const formData = new FormData()
  for (const [key, value] of entries) formData.append(key, value)
  return formData
}

function variables(count: number): (readonly [string, string])[] {
  return Array.from({ length: count }, (_, index) => [`extra${index}`, 'x'] as const)
}

async function rootErrors(input: FormData | URLSearchParams | Request, definition: ValidationSchema = schema({ name: field.string().optional() })) {
  const result = await safeParse(input, definition)
  expect(result.valid).toBe(false)
  return result.valid ? [] : result.errors.get('_root')
}

describe('Validation input bounds', () => {
  it('limits a request to 1,000 input variables', async () => {
    const definition = schema({ name: field.string().required() })

    expect((await safeParse(formWith([['name', 'Ava'], ...variables(999)]), definition)).valid).toBe(true)

    const tooMany = [['name', 'Ava'] as const, ...variables(1_000)]
    expect(await rootErrors(formWith(tooMany), definition)).toEqual(['The request contains too many input variables.'])
    expect(await rootErrors(new URLSearchParams(tooMany.map(([key, value]) => [key, value])), definition))
      .toEqual(['The request contains too many input variables.'])
    expect(await rootErrors(new Request(`https://example.com/?${new URLSearchParams(tooMany.map(([key, value]) => [key, value]))}`), definition))
      .toEqual(['The request contains too many input variables.'])
    expect(await rootErrors(new Request('https://example.com/', { method: 'POST', body: formWith(tooMany) }), definition))
      .toEqual(['The request contains too many input variables.'])
  })

  it('does not count uploaded files as input variables', async () => {
    const formData = formWith([['name', 'Ava'], ...variables(999)])
    formData.append('attachments[]', new File(['report'], 'report.txt'))
    formData.append('attachments[]', new File(['summary'], 'summary.txt'))

    const result = await safeParse(formData, schema({ name: field.string().required(), attachments: field.array(field.file()) }))

    expect(result.valid).toBe(true)
  })

  it('requires every array index to be lower than the entries submitted for that array', async () => {
    const definition = schema({
      tags: field.array(field.string()).optional(),
      rows: field.array({ name: field.string().optional() }).optional(),
    })

    const ordered = await safeParse(formWith([['tags[1]', 'b'], ['tags[0]', 'a']]), definition)
    expect(ordered.valid).toBe(true)
    if (ordered.valid) expect(ordered.data.tags).toEqual(['a', 'b'])

    for (const query of ['tags=a&tags=b&tags[]=c', 'tags[]=a&tags=b&tags[]=c']) {
      const repeated = await safeParse(new URLSearchParams(query), definition)
      expect(repeated.valid, query).toBe(true)
      if (repeated.valid) expect(repeated.data.tags).toEqual(['a', 'b', 'c'])
    }

    expect(await rootErrors(formWith([['tags[999999999]', 'x']]), definition))
      .toEqual(['The request contains an invalid list index.'])
    expect(await rootErrors(formWith([['tags[0]', 'a'], ['tags[2]', 'c']]), definition))
      .toEqual(['The request contains an invalid list index.'])
    expect(await rootErrors(new URLSearchParams('rows[0][name]=a&rows[5][name]=b'), definition))
      .toEqual(['The request contains an invalid list index.'])
    expect(await rootErrors(new URLSearchParams('tags[3]=a&tags[3]=b&tags[3]=c&tags[3]=d'), definition))
      .toEqual(['The request contains an invalid list index.'])
    expect(await rootErrors(new URLSearchParams('rows[1][name]=a&rows[1][name]=b'), definition))
      .toEqual(['The request contains an invalid list index.'])
    expect(await rootErrors(new URLSearchParams('tags[4294967294]=a&tags[]=b'), definition))
      .toEqual(['The request contains an invalid list index.'])
  })

  it('enforces declared list maximums before validating items', async () => {
    const checked: string[] = []
    const definition = schema({
      tags: field.array(field.string().custom((value) => {
        checked.push(value)
        return true
      })).max(2),
      codes: field.array(field.string().custom((value) => {
        checked.push(value)
        return true
      })).size(1),
    })

    const rows = Array.from({ length: 3 }, (_, index) => ({
      get name() {
        checked.push(`row${index}`)
        return 'row'
      },
    }))
    const result = await safeParse({ tags: ['a', 'b', 'c'], codes: ['x', 'y'], rows }, schema({
      ...definition.fields,
      rows: field.array({ name: field.string() }).max(1),
    }))

    expect(checked).toEqual([])
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errors.get('tags')).toEqual(['This field must contain 2 items or fewer.'])
      expect(result.errors.get('codes')).toEqual(['This field must contain exactly 1 item.'])
      expect(result.errors.get('rows')).toEqual(['This field must contain 1 item or fewer.'])
    }
  })

  it('keeps item errors for undersized lists and skips items for oversized ones', async () => {
    const checked: string[] = []
    const definition = schema({
      emails: field.array(field.string().email().custom((value) => {
        checked.push(value)
        return true
      })).size(2),
    })

    const undersized = await safeParse({ emails: ['invalid'] }, definition)
    expect(undersized.valid).toBe(false)
    if (!undersized.valid) {
      expect(undersized.errors.get('emails')).toEqual(['This field must contain exactly 2 items.'])
      expect(undersized.errors.get('emails.0')).toEqual(['This field must be a valid email address.'])
    }

    checked.length = 0
    const oversized = await safeParse({ emails: ['a@example.com', 'b@example.com', 'invalid'] }, definition)
    expect(oversized.valid).toBe(false)
    if (!oversized.valid) expect(oversized.errors.get('emails')).toEqual(['This field must contain exactly 2 items.'])
    expect(checked).toEqual([])
  })

  it('validates malformed JSON as empty input', async () => {
    const definition = schema({ name: field.string().required() })
    const request = new Request('https://example.com/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":',
    })

    const result = await safeParse(request, definition)

    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors.flatten()).toEqual({ name: ['This field is required.'] })
  })

  it('validates an unparseable form body as empty input', async () => {
    const request = new Request('https://example.com/', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=missing' },
      body: 'not a multipart body',
    })

    const result = await safeParse(request, schema({ name: field.string().required() }))

    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors.flatten()).toEqual({ name: ['This field is required.'] })
  })

  it('gives every order of colliding names the same outcome', async () => {
    const forms: readonly ((value: string) => string)[] = [
      value => `x=${value}`,
      value => `x[]=${value}`,
      value => `x[0]=${value}`,
      value => `x[k]=${value}`,
      value => `x[k][]=${value}`,
      value => `x[0][k]=${value}`,
    ]
    const permutations = <T>(items: readonly T[]): T[][] => items.length <= 1
      ? [[...items]]
      : items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(rest => [item, ...rest]))
    const canonical = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonical).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonical(entry)]))
      }
      return value
    }
    const outcome = (parts: readonly string[]) => {
      try {
        return { value: canonical(validationInternals.normalizeFormData(new URLSearchParams(parts.join('&')))) }
      } catch (error) {
        return { invalid: error instanceof Error ? error.message : String(error) }
      }
    }

    expect(outcome(['tags[name]=a', 'tags[]=b'])).toEqual({ invalid: 'The request contains an invalid field name.' })
    expect(outcome(['tags[]=b', 'tags[name]=a'])).toEqual({ invalid: 'The request contains an invalid field name.' })
    expect(outcome(['tags=a', 'tags[]=b'])).toEqual({ value: { tags: ['a', 'b'] } })
    expect(outcome(['tags[]=b', 'tags=a'])).toEqual({ value: { tags: ['a', 'b'] } })
    expect(outcome(['tags[0]=a', 'tags[]=b'])).toEqual({ invalid: 'The request contains an invalid field name.' })
    expect(outcome(['tags[]=b', 'tags[0]=a'])).toEqual({ invalid: 'The request contains an invalid field name.' })
    expect(outcome(['tags=a', 'tags[0]=b'])).toEqual({ invalid: 'The request contains an invalid field name.' })
    expect(outcome(['tags[0]=b', 'tags=a'])).toEqual({ invalid: 'The request contains an invalid field name.' })

    const sequences: number[][] = []
    for (const first of forms.keys()) {
      for (const second of forms.keys()) {
        sequences.push([first, second])
        for (const third of forms.keys()) sequences.push([first, second, third])
      }
    }

    for (const sequence of sequences) {
      const items = sequence.map((form, position) => forms[form]!(`v${position}`))
      const label = items.join(' & ')
      const results = permutations(items).map(outcome)
      expect(new Set(results.map(result => 'invalid' in result)).size, label).toBe(1)
      const overwritesIndex = sequence.filter(form => form === 2).length > 1
      if (!overwritesIndex) expect(new Set(results.map(result => JSON.stringify(result))).size, label).toBe(1)
    }
  })

  it('reports prototype and mixed index/key paths as validation failures', async () => {
    expect(await rootErrors(formWith([['__proto__.polluted', 'yes']]))).toEqual(['The request contains an invalid field name.'])
    expect(await rootErrors(new URLSearchParams('constructor[prototype][polluted]=yes'))).toEqual(['The request contains an invalid field name.'])
    expect(await rootErrors(formWith([['tags[0]', 'a'], ['tags[name]', 'b']]))).toEqual(['The request contains an invalid field name.'])
    expect(await rootErrors(formWith([['tags[name]', 'a'], ['tags[0]', 'b']]))).toEqual(['The request contains an invalid field name.'])
    expect(Object.prototype).not.toHaveProperty('polluted')

    await expect(validate(formWith([['__proto__.polluted', 'yes']]), schema({ name: field.string().optional() })))
      .rejects.toBeInstanceOf(ValidationException)
  })

  it('surfaces exceptions thrown by custom rules instead of reporting them as validation messages', async () => {
    const failure = new Error('database unavailable')
    const sync = schema({ name: field.string().custom(() => { throw failure }) })
    const async = schema({ name: field.string().customAsync(async () => { throw failure }) })

    await expect(safeParse({ name: 'Ava' }, sync)).rejects.toBe(failure)
    await expect(safeParse({ name: 'Ava' }, async)).rejects.toBe(failure)
    await expect(validate({ name: 'Ava' }, async)).rejects.toBe(failure)
  })

  it('checks file size before decoding an image', async () => {
    let fullReads = 0
    class TrackedFile extends File {
      override arrayBuffer(): Promise<ArrayBuffer> {
        fullReads += 1
        return super.arrayBuffer()
      }
    }
    const avatar = new TrackedFile([pngPixel, new Uint8Array(4096)], 'avatar.png', { type: 'image/png' })

    const result = await safeParse({ avatar }, schema({ avatar: field.file().required().image().maxSize('1kb') }))

    expect(fullReads).toBe(0)
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors.get('avatar')).toEqual(['The selected file must be 1 KB or smaller.'])
  })

  it('rejects a transformed image that is too large to decode', async () => {
    const original = new File([pngPixel], 'avatar.png', { type: 'image/png' })
    const replacement = new File([pngPixel.subarray(0, 64), new Uint8Array(4096)], 'avatar.png', { type: 'image/png' })

    const result = await safeParse({ avatar: original }, schema({
      avatar: field.file().required().transform(() => replacement).image().maxSize('1kb'),
    }))

    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors.get('avatar')).toEqual(['The selected file must be an image.'])
  })
})
