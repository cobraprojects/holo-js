import {
  inferMimeType,
  isImageSource,
  normalizeOutputFormat,
  replaceFileExtension,
  toBuffer,
} from './binary'
import type {
  MediaConversionExecutor,
} from '../registry'
import type sharp from 'sharp'

type FitMode = 'contain' | 'cover' | 'fill' | 'inside' | 'outside'

let sharpFactoryPromise: Promise<typeof sharp> | undefined

async function loadSharp(): Promise<typeof sharp> {
  sharpFactoryPromise ??= import('sharp')
    .then(module => module.default)
    .catch((error: unknown) => {
      sharpFactoryPromise = undefined
      throw error
    })

  return sharpFactoryPromise
}

function resolveFit(mode?: string): FitMode {
  switch (mode) {
    case 'contain':
    case 'cover':
    case 'fill':
    case 'inside':
    case 'outside':
      return mode
    default:
      return 'cover'
  }
}

export function createDefaultMediaConversionExecutor(): MediaConversionExecutor {
  return {
    async generate({ source, conversion }) {
      if (!isImageSource(source.mimeType, source.extension)) {
        return null
      }

      const outputFormat = normalizeOutputFormat(source.extension, conversion.format)

      try {
        const sharp = await loadSharp()
        let pipeline = sharp(await toBuffer(source.contents), {
          animated: true,
          failOn: 'warning',
        }).rotate()

        if (conversion.width || conversion.height) {
          pipeline = pipeline.resize({
            width: conversion.width,
            height: conversion.height,
            fit: resolveFit(conversion.fit),
            withoutEnlargement: true,
          })
        }

        switch (outputFormat) {
          case 'avif':
            pipeline = pipeline.avif({
              quality: conversion.quality ?? 80,
              effort: 4,
            })
            break
          case 'jpeg':
          case 'jpg':
            pipeline = pipeline.jpeg({
              quality: conversion.quality ?? 82,
              mozjpeg: true,
            })
            break
          case 'png':
            pipeline = pipeline.png({
              compressionLevel: 9,
              quality: conversion.quality,
            })
            break
          case 'webp':
            pipeline = pipeline.webp({
              quality: conversion.quality ?? 82,
              effort: 4,
            })
            break
        }

        const contents = await pipeline.toBuffer()
        const fileName = replaceFileExtension(source.fileName, outputFormat)

        return {
          contents,
          fileName,
          mimeType: inferMimeType(fileName),
        }
      } catch (error) {
        throw new Error(
          `[Holo Media] Failed to generate conversion "${conversion.name}" for "${source.fileName}": ${(error as Error).message}`,
        )
      }
    },
  }
}

export const defaultMediaConversionExecutor = createDefaultMediaConversionExecutor()

interface MediaImageInspection {
  readonly mimeType: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp'
  readonly width: number
  readonly height: number
  readonly pages: number
}

const imageMimeTypes = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
} as const

export const mediaRuntimeInternals = Object.freeze({
  async inspectImage(contents: Uint8Array, maximumPixels = 40_000_000): Promise<MediaImageInspection> {
    if (!Number.isSafeInteger(maximumPixels) || maximumPixels < 1) throw new TypeError('[Holo Media] Image pixel limits require a positive integer.')
    const factory = await loadSharp()
    try {
      const image = factory(Buffer.from(contents), { animated: true, failOn: 'warning', limitInputPixels: maximumPixels })
      const metadata = await image.metadata()
      const { width, height } = metadata
      const format = metadata.format
      if (format !== 'gif' && format !== 'jpeg' && format !== 'png' && format !== 'webp') throw new Error('[Holo Media] Unsupported raster image format.')
      if (!width || !height || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width * height > maximumPixels) throw new Error('[Holo Media] Image exceeds the pixel limit.')
      await image.stats()
      return { mimeType: imageMimeTypes[format], width, height: metadata.pageHeight ?? height, pages: metadata.pages ?? 1 }
    } catch (error) {
      throw new Error('[Holo Media] Image could not be decoded.', { cause: error })
    }
  },
})
