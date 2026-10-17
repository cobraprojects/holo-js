import type { FileHandle } from 'node:fs/promises'

const maximumInspectionBytes = 65_536

export async function inspectMimeType(contents: Uint8Array): Promise<string> {
  const { fileTypeFromBuffer } = await import('file-type')
  try {
    const result = await fileTypeFromBuffer(contents.subarray(0, maximumInspectionBytes), { maxBufferSize: maximumInspectionBytes })
    return result?.mime ?? 'application/octet-stream'
  } catch {
    return 'application/octet-stream'
  }
}

export async function inspectFileMimeType(file: FileHandle): Promise<string> {
  const buffer = Buffer.alloc(maximumInspectionBytes)
  const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
  return inspectMimeType(buffer.subarray(0, bytesRead))
}
