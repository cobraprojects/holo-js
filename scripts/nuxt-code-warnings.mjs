const nuxtBuildCodePattern = /\bNUXT_B\d{4}\b/

function findNuxtCodeWarnings(output) {
  return output
    .split(/\r?\n/)
    .flatMap((line) => {
      const code = line.match(nuxtBuildCodePattern)?.[0]
      return code ? [{ code, line: line.trim() }] : []
    })
}

export function assertNoNuxtCodeWarnings(step, output) {
  const warnings = findNuxtCodeWarnings(output)
  if (warnings.length === 0) return

  throw new Error([
    `Nuxt reported ${warnings.length} code warning(s) during ${step}:`,
    ...warnings.map(warning => `  ${warning.code}: ${warning.line}`),
  ].join('\n'))
}
