import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { field, safeParse, schema } from '../src'

const imageMessage = 'The selected file must be an image.'
const avatarContract = schema({ avatar: field.file().required().image() })

async function fixture(name: string, declaredName = name, declaredType = ''): Promise<File> {
  const contents = await readFile(new URL(`./fixtures/images/${name}`, import.meta.url))
  return new File([contents], declaredName, { type: declaredType })
}

async function avatarErrors(avatar: File): Promise<readonly string[]> {
  const result = await safeParse({ avatar }, avatarContract)
  return result.valid ? [] : result.errors.get('avatar')
}

afterEach(() => {
  vi.doUnmock('sharp')
  vi.resetModules()
})

describe('image validation', () => {
  it.each(['valid.png', 'valid.jpeg', 'animated.gif', 'animated.webp', 'valid.avif', 'valid.tiff'])(
    'accepts the fully decodable image %s whatever name and type the client declares',
    async (name) => {
      expect(await avatarErrors(await fixture(name, 'upload.bin', 'text/plain'))).toEqual([])
    },
  )

  it.each(['corrupted-pixels.png', 'truncated.png', 'truncated.jpeg', 'truncated-animated.gif', 'truncated-animated.webp'])(
    'rejects %s whose image signature is valid but whose data cannot be fully decoded',
    async (name) => {
      expect(await avatarErrors(await fixture(name, name, 'image/png'))).toEqual([imageMessage])
    },
  )

  it.each(['oversized-pixels.png', 'too-many-frames.gif'])(
    'rejects %s whose decoded pixels or frames exceed the validation bounds',
    async (name) => {
      expect(await avatarErrors(await fixture(name))).toEqual([imageMessage])
    },
  )

  it.each([
    ['scripted.svg', 'logo.svg', 'image/svg+xml'],
    ['disguised-avatar.png', 'avatar.png', 'image/png'],
    ['bitmap.bmp', 'photo.bmp', 'image/bmp'],
  ])('rejects %s declared as %s (%s) because its bytes are not a decodable raster image', async (name, declaredName, declaredType) => {
    expect(await avatarErrors(await fixture(name, declaredName, declaredType))).toEqual([imageMessage])
  })

  it('asks for the optional sharp package instead of weakening server-side image validation', async () => {
    vi.doMock('sharp', () => {
      throw Object.assign(new Error('Cannot find package \'sharp\''), { code: 'ERR_MODULE_NOT_FOUND' })
    })
    const validation = await import('../src')
    const contract = validation.schema({ avatar: validation.field.file().required().image() })
    const result = await validation.safeParse({ avatar: await fixture('valid.png') }, contract)
    expect(result.valid).toBe(false)
    expect(result.valid ? [] : result.errors.get('_root')).toEqual([
      '[@holo-js/kernel] Server-side image validation requires the optional "sharp" package. Install sharp in your application.',
    ])
  })
})
