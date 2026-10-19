export async function resolve(specifier, context, next) {
  if ((specifier === 'node:fs/promises' || specifier === 'fs/promises') && !context.parentURL?.endsWith('/fs.mjs')) {
    return { url: new URL('./fs.mjs', import.meta.url).href, shortCircuit: true }
  }
  return next(specifier, context)
}
