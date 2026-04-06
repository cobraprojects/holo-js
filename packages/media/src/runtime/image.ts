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

type SharpPipeline = {
  rotate(): SharpPipeline
  resize(options: {
    width?: number
    height?: number
    fit?: FitMode
    withoutEnlargement?: boolean
  }): SharpPipeline
  avif(options: { quality?: number, effort?: number }): SharpPipeline
  jpeg(options: { quality?: number, mozjpeg?: boolean }): SharpPipeline
  png(options: { compressionLevel?: number, quality?: number }): SharpPipeline
  webp(options: { quality?: number, effort?: number }): SharpPipeline
  toBuffer(): Promise<Buffer>
}

type SharpFactory = (input: Buffer, options?: {
  animated?: boolean
  failOn?: 'warning'
}) => SharpPipeline
type FitMode = 'contain' | 'cover' | 'fill' | 'inside' | 'outside'

let sharpFactoryPromise: Promise<SharpFactory> | undefined

async function loadSharp(): Promise<SharpFactory> {
  sharpFactoryPromise ??= import('sharp')
    .then((module) => {
      const resolved = module as unknown as SharpFactory & { default?: SharpFactory }
      /* v8 ignore next -- The direct callable-module fallback depends on runtime module interop and is not reproducible under Vitest mocks. */
      return resolved.default ?? resolved
    })
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
