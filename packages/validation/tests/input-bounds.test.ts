import { describe, expect, it } from 'vitest'
import { ValidationException, field, safeParse, schema, validate, validationInternals, type ValidationSchema, type SchemaInputShape } from '../src'

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

  it.each(['form data', 'multipart request'])('limits uploaded files separately from non-file variables in %s', async (format) => {
    const formData = formWith([['name', 'Ava'], ...variables(999)])
    const file = new File(['report'], 'report.txt')
    for (let index = 0; index < 1_000; index += 1) formData.append('attachments[]', file)
    const definition = schema({ name: field.string().required(), attachments: field.array(field.file()) })
    const input = () => format === 'form data' ? formData : new Request('https://example.com/', { method: 'POST', body: formData })

    const accepted = await safeParse(input(), definition)
    expect(accepted.valid).toBe(true)
    if (accepted.valid) expect(accepted.data.attachments).toHaveLength(1_000)

    formData.append('attachments[]', file)
    expect(await rootErrors(input(), definition)).toEqual(['The request contains too many input variables.'])
  })

  it.each([
    ['form', 'brackets'],
    ['form', 'dots'],
    ['query', 'brackets'],
    ['query', 'dots'],
  ])('accepts 64 nesting levels and rejects 65 in %s names with %s', async (format, notation) => {
    let shape: SchemaInputShape = { leaf: field.string().required() }
    for (let level = 1; level < 64; level += 1) shape = { child: shape }
    const definition = schema({ root: shape })
    const input = (depth: number) => {
      const path = notation === 'dots' ? `root${'.child'.repeat(depth - 1)}.leaf` : `root${'[child]'.repeat(depth - 1)}[leaf]`
      const entries = [[path, 'value']] as const
      return format === 'form' ? formWith(entries) : new URLSearchParams(entries.map(([key, value]) => [key, value]))
    }

    expect((await safeParse(input(64), definition)).valid).toBe(true)
    expect(await rootErrors(input(65), definition)).toEqual(['The request contains a field nested too deeply.'])
  })

  it('rejects 1,000 fields nested 500 levels deep', async () => {
    const formData = formWith(Array.from({ length: 1_000 }, (_, index) => [`field${index}${'[x]'.repeat(500)}`, 'value'] as const))

    expect(await rootErrors(formData)).toEqual(['The request contains a field nested too deeply.'])
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

  it('applies list bounds to the value at their position in the pipeline', async () => {
    const result = await safeParse({ tags: ['a', 'b'], codes: ['1', '2'] }, schema({
      tags: field.array(field.string()).transform(values => values.slice(0, 1)).max(1),
      codes: field.array(field.number()).max(3).transform(values => values.slice(0, 1)).size(1),
    }))

    expect(result.valid).toBe(true)
    if (result.valid) expect(result.data).toEqual({ tags: ['a'], codes: [1] })

    const oversized = await safeParse({ tags: ['a', 'b'] }, schema({
      tags: field.array(field.string()).max(1).transform(values => values.slice(0, 1)),
    }))
    expect(oversized.valid).toBe(false)
    if (!oversized.valid) expect(oversized.errors.get('tags')).toEqual(['This field must contain 1 item or fewer.'])
  })

  it('reports every applicable parent constraint without visiting oversized list items', async () => {
    let reads = 0
    let transforms = 0
    const rows = Array.from({ length: 2 }, () => ({
      get code() {
        reads += 1
        return '1'
      },
    }))
    const result = await safeParse({ rows }, schema({
      rows: field.array({ code: field.number() })
        .size(3, 'Need exactly three rows.')
        .max(1, 'Only one row allowed.')
        .min(4, 'Need at least four rows.')
        .transform(values => {
          transforms += 1
          return values.slice(0, 1)
        })
        .max(0, 'Post-transform bound.'),
    }))

    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors.flatten()).toEqual({
      rows: ['Need exactly three rows.', 'Only one row allowed.', 'Need at least four rows.'],
    })
    expect(reads).toBe(0)
    expect(transforms).toBe(0)
  })

  it('skips parent custom rules on oversized lists with unchecked items', async () => {
    let checks = 0
    const check = (values: number[]) => {
      checks += 1
      return values.every(value => value.toFixed(0) !== '')
    }
    const result = await safeParse({ before: ['a', 'b'], after: ['a', 'b'] }, schema({
      before: field.array(field.number()).custom(check).max(1),
      after: field.array(field.number()).max(1).customAsync(async values => check(values)),
    }))

    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors.flatten()).toEqual({
      before: ['This field must contain 1 item or fewer.'],
      after: ['This field must contain 1 item or fewer.'],
    })
    expect(checks).toBe(0)
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

  it.each([
    ['multipart/form-data; boundary=form', Error],
    ['multipart/form-data; boundary=form', TypeError],
    ['application/x-www-form-urlencoded', Error],
    ['application/x-www-form-urlencoded', TypeError],
  ] as const)('propagates body stream failures for %s (%s)', async (contentType, Failure) => {
    const failure = new Failure('body stream failed')
    let sentFileChunk = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const prefix = contentType.startsWith('multipart/')
          ? '--form\r\nContent-Disposition: form-data; name="upload"; filename="report.txt"\r\nContent-Type: text/plain\r\n\r\n'
          : 'name=Ava&upload='
        controller.enqueue(new TextEncoder().encode(prefix))
      },
      pull(controller) {
        if (!sentFileChunk) {
          sentFileChunk = true
          controller.enqueue(new Uint8Array(4096).fill(97))
        } else {
          controller.error(failure)
        }
      },
    })
    const request = new Request('https://example.com/', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
      ...{ duplex: 'half' },
    })

    await expect(safeParse(request, schema({ name: field.string().required() }))).rejects.toBe(failure)
  })

  it.each(['multipart/form-data; boundary=form', 'application/x-www-form-urlencoded'])('propagates locked-body errors for %s', async (contentType) => {
    const request = new Request('https://example.com/', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: 'name=Ava',
    })
    const reader = request.body!.getReader()
    try {
      await expect(safeParse(request, schema({ name: field.string().required() }))).rejects.toBeInstanceOf(TypeError)
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
  })

  it.each(['multipart/form-data', 'application/x-www-form-urlencoded'])('propagates consumed-body errors for %s', async (contentType) => {
    const request = new Request('https://example.com/', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: 'name=Ava',
    })
    await request.text()

    await expect(safeParse(request, schema({ name: field.string().required() }))).rejects.toBeInstanceOf(TypeError)
  })

  it.each(['urlencoded', 'multipart'])('preserves %s request values and files', async (format) => {
    const entries = [['name', 'Ava'], ['tags[]', 'a'], ['tags[]', 'b']] as const
    const body = format === 'multipart' ? formWith(entries) : new URLSearchParams(entries.map(([key, value]) => [key, value]))
    if (body instanceof FormData) body.append('attachment', new File(['report'], 'report.txt', { type: 'text/plain' }))
    const result = await safeParse(new Request('https://example.com/', { method: 'POST', body }), schema({
      name: field.string().required(),
      tags: field.array(field.string()),
      attachment: field.file().optional(),
    }))

    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.data.name).toBe('Ava')
      expect(result.data.tags).toEqual(['a', 'b'])
      if (format === 'multipart') {
        expect(result.data.attachment?.name).toBe('report.txt')
        expect(await result.data.attachment?.text()).toBe('report')
      }
    }
  })

  it.each(['multipart/form-data', 'multipart/form-data; boundary=missing'])('validates malformed %s as empty input', async (contentType) => {
    const request = new Request('https://example.com/', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: 'not a multipart body',
    })

    const result = await safeParse(request, schema({ name: field.string().required() }))

    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors.flatten()).toEqual({ name: ['This field is required.'] })
  })

  it.each([
    ['tag=a&tag[]=b', ['a', 'b']],
    ['tag[]=b&tag=a', ['b', 'a']],
    ['tag=a&tag=b&tag[]=c', ['a', 'b', 'c']],
    ['tag=a&tag[]=c&tag=b', ['a', 'c', 'b']],
    ['tag=b&tag=a&tag[]=c', ['b', 'a', 'c']],
    ['tag=b&tag[]=c&tag=a', ['b', 'c', 'a']],
    ['tag[]=c&tag=a&tag=b', ['c', 'a', 'b']],
    ['tag[]=c&tag=b&tag=a', ['c', 'b', 'a']],
  ])('keeps explicit append syntax as a list in %s', async (query, expected) => {
    const input = new URLSearchParams(query)
    const scalar = await safeParse(input, schema({ tag: field.string() }))
    expect(scalar.valid).toBe(false)
    if (!scalar.valid) expect(scalar.errors.get('tag')).toEqual(['This field must be text.'])

    const list = await safeParse(input, schema({ tag: field.array(field.string()) }))
    expect(list.valid).toBe(true)
    if (list.valid) expect(list.data.tag).toEqual(expected)
  })

  it.each([
    'tags[0]=a&tags[0][]=b',
    'tags[0][]=b&tags[0]=a',
    'tags[0]=a&tags[0]=b&tags[0][]=c',
    'tags[0]=a&tags[0][]=c&tags[0]=b',
    'tags[0]=b&tags[0]=a&tags[0][]=c',
    'tags[0]=b&tags[0][]=c&tags[0]=a',
    'tags[0][]=c&tags[0]=a&tags[0]=b',
    'tags[0][]=c&tags[0]=b&tags[0]=a',
  ])('rejects scalar/append collisions at numbered slots in %s', async (query) => {
    expect(await rootErrors(new URLSearchParams(query), schema({ tags: field.array(field.string()) })))
      .toEqual(['The request contains an invalid field name.'])
  })

  it.each([
    ['tags[0]=a&tags[0]=b', 'b'],
    ['tags[0]=b&tags[0]=a', 'a'],
  ])('retains the last repeated numbered scalar in %s', async (query, expected) => {
    const result = await safeParse(new URLSearchParams(query), schema({ tags: field.array(field.string()) }))
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.data.tags).toEqual([expected])
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

  it('decodes a transformed valid image without applying a bound from the previous value', async () => {
    const original = new File([pngPixel], 'small.png', { type: 'image/png' })
    const replacement = new File([pngPixel, new Uint8Array(4096)], 'large.png', { type: 'image/png' })
    const result = await safeParse({ avatar: original }, schema({
      avatar: field.file().maxSize('1kb').transform(() => replacement).image(),
    }))

    expect(result.valid).toBe(true)
    if (result.valid) expect(result.data.avatar).toBe(replacement)
  })

  it.each(['bounded first', 'bounded last'])('keeps image verification separate across transforms with the same file (%s)', async (order) => {
    let fullReads = 0
    class TrackedFile extends File {
      override arrayBuffer(): Promise<ArrayBuffer> {
        fullReads += 1
        return super.arrayBuffer()
      }
    }
    const avatar = new TrackedFile([pngPixel, new Uint8Array(4096)], 'avatar.png', { type: 'image/png' })
    const definition = order === 'bounded first'
      ? field.file().image().maxSize('1kb').transform(value => value).imageAspectRatio('1:1')
      : field.file().image().transform(value => value).imageAspectRatio('2:1').maxSize('1kb')
    const result = await safeParse({ avatar }, schema({ avatar: definition }))

    expect(fullReads).toBe(1)
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
