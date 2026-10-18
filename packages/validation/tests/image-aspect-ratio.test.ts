import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { field, safeParse, schema, ValidationContractError } from '../src'

const ratioMessage = 'The selected image must have an allowed aspect ratio.'
const squareAvatar = schema({ avatar: field.file().required().imageAspectRatio('1:1') })

async function fixture(name: string): Promise<File> {
  const contents = await readFile(new URL(`./fixtures/images/${name}`, import.meta.url))
  return new File([contents], 'avatar.png', { type: 'image/png' })
}

describe('image aspect ratio validation', () => {
  it('accepts a square avatar and retains the original uploaded file', async () => {
    const avatar = await fixture('square.png')
    const result = await safeParse({ avatar }, squareAvatar)
    expect(result.valid).toBe(true)
    expect(result.data?.avatar).toBe(avatar)
  })

  it('rejects a non-square avatar with the authored message', async () => {
    const contract = schema({ avatar: field.file().imageAspectRatio('1:1', 'Upload a square avatar.') })
    const result = await safeParse({ avatar: await fixture('valid.png') }, contract)
    expect(result.errors.get('avatar')).toEqual(['Upload a square avatar.'])
  })

  it.each(['valid.png', 'valid.jpeg', 'valid.avif', 'valid.tiff', 'animated.gif', 'animated.webp'])(
    'accepts %s matching any authored ratio using individual frame dimensions',
    async (name) => {
      const contract = schema({ avatar: field.file().image().imageAspectRatio(['1:1', '3:2']) })
      expect((await safeParse({ avatar: await fixture(name) }, contract)).valid).toBe(true)
    },
  )

  it('rejects images matching none of the authored ratios', async () => {
    const contract = schema({ avatar: field.file().imageAspectRatio(['1:1', '16:9']) })
    const result = await safeParse({ avatar: await fixture('valid.png') }, contract)
    expect(result.errors.get('avatar')).toEqual([ratioMessage])
  })

  it.each([
    ['rounded-ratio.png', true],
    ['outside-ratio-tolerance.png', false],
  ])('applies Laravel dimension-dependent tolerance to %s', async (name, valid) => {
    const contract = schema({ avatar: field.file().imageAspectRatio('16:9') })
    expect((await safeParse({ avatar: await fixture(name) }, contract)).valid).toBe(valid)
  })

  it('uses encoded dimensions without applying EXIF rotation', async () => {
    const avatar = await fixture('oriented.jpeg')
    const landscape = schema({ avatar: field.file().imageAspectRatio('3:2') })
    const portrait = schema({ avatar: field.file().imageAspectRatio('2:3') })
    expect((await safeParse({ avatar }, landscape)).valid).toBe(true)
    expect((await safeParse({ avatar }, portrait)).valid).toBe(false)
  })

  it.each([
    'corrupted-pixels.png',
    'truncated.png',
    'truncated.jpeg',
    'truncated-animated.gif',
    'truncated-animated.webp',
    'oversized-pixels.png',
    'too-many-frames.gif',
    'scripted.svg',
    'disguised-avatar.png',
    'bitmap.bmp',
  ])('rejects unsafe %s even without image()', async (name) => {
    const result = await safeParse({ avatar: await fixture(name) }, squareAvatar)
    expect(result.errors.get('avatar')).toEqual([ratioMessage])
  })

  it('preserves image errors when combined and reports only ratio errors for safe images', async () => {
    const contract = schema({ avatar: field.file().image().imageAspectRatio('1:1') })
    const unsafe = await safeParse({ avatar: await fixture('corrupted-pixels.png') }, contract)
    const nonSquare = await safeParse({ avatar: await fixture('valid.png') }, contract)
    expect(unsafe.errors.get('avatar')).toEqual(['The selected file must be an image.', ratioMessage])
    expect(nonSquare.errors.get('avatar')).toEqual([ratioMessage])
  })

  it('checks every constraint when multiple ratio rules are declared', async () => {
    const contract = schema({ avatar: field.file().imageAspectRatio(['1:1', '3:2']).imageAspectRatio('1:1') })
    expect((await safeParse({ avatar: await fixture('square.png') }, contract)).valid).toBe(true)
    expect((await safeParse({ avatar: await fixture('valid.png') }, contract)).valid).toBe(false)
  })

  it('validates a transformed file separately from the original image', async () => {
    const nonSquare = await fixture('valid.png')
    const contract = schema({ avatar: field.file().image().transform(() => nonSquare).imageAspectRatio('1:1') })
    const result = await safeParse({ avatar: await fixture('square.png') }, contract)
    expect(result.errors.get('avatar')).toEqual([ratioMessage])
  })

  it.each(['0:1', '1:0', '-1:1', '1:Infinity', 'NaN:1', '1', '1:2:3', ':1', '1:'])('rejects invalid ratio %s at declaration', (ratio) => {
    expect(() => field.file().imageAspectRatio(ratio as `${number}:${number}`)).toThrow(ValidationContractError)
  })

  it('rejects empty lists and non-file fields at declaration', () => {
    expect(() => field.file().imageAspectRatio([])).toThrow(ValidationContractError)
    expect(() => field.string().imageAspectRatio('1:1')).toThrow(ValidationContractError)
  })
})
