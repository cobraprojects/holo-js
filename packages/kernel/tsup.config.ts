import { defineConfig } from 'tsup'

const outDir = process.env.HOLO_BUILD_OUT_DIR ?? 'dist'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'error-reporting': 'src/errorReporting.ts',
    'http-errors': 'src/httpErrors.ts',
    'managed-resources': 'src/managedResources.ts',
    'file-content': 'src/fileContent.ts',
    'request-body': 'src/requestBody.ts',
    'image-decoding': 'src/imageDecoding.ts',
    'image-decoding.browser': 'src/imageDecoding.browser.ts',
    'image-decoding.node': 'src/imageDecoding.node.ts',
  },
  external: ['sharp'],
  format: ['esm'],
  dts: true,
  clean: true,
  outDir,
  outExtension: () => ({ js: '.mjs' }),
})
