import { mimeTypeFromFileName } from '@holo-js/kernel/file-content'
import {
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
      if (!source.mimeType?.toLowerCase().startsWith('image/')) {
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
          mimeType: mimeTypeFromFileName(fileName) ?? undefined,
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
