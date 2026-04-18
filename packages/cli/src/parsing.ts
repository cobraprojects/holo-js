import { createInterface } from 'node:readline/promises'
import type { CommandFlagValue } from './types'
import type { IoStreams, RawParsedInput, SupportedScaffoldOptionalPackage, NewProjectInput } from './cli-types'

export const SUPPORTED_NEW_FRAMEWORKS = ['nuxt', 'next', 'sveltekit'] as const
export const SUPPORTED_NEW_DATABASE_DRIVERS = ['sqlite', 'mysql', 'postgres'] as const
export const SUPPORTED_NEW_PACKAGE_MANAGERS = ['bun', 'npm', 'pnpm', 'yarn'] as const
export const SUPPORTED_NEW_STORAGE_DISKS = ['local', 'public'] as const
export const SUPPORTED_NEW_OPTIONAL_PACKAGES = ['storage', 'events', 'queue', 'validation', 'forms', 'auth', 'notifications', 'mail', 'security'] as const
export const SUPPORTED_INSTALL_TARGETS = ['queue', 'events', 'auth', 'notifications', 'mail', 'broadcast', 'security'] as const
export const SUPPORTED_QUEUE_INSTALL_DRIVERS = ['sync', 'redis', 'database'] as const

export function parseTokens(tokens: readonly string[]): RawParsedInput {
  const args: string[] = []
  const flags: Record<string, string | boolean | readonly string[]> = {}
  const isNumericValueToken = (value: string | undefined) => typeof value === 'string' && /^-\d+$/.test(value)

  const assignFlag = (name: string, value: string | boolean) => {
    const existing = flags[name]
    if (typeof existing === 'undefined') {
      flags[name] = value
      return
    }

    if (Array.isArray(existing)) {
      flags[name] = [...existing, String(value)]
      return
    }

    flags[name] = [String(existing), String(value)]
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    /* v8 ignore next 3 */
    if (typeof token === 'undefined') {
      continue
    }
    if (token === '--') {
      args.push(...tokens.slice(index + 1))
      break
    }

    if (token.startsWith('--')) {
      const flag = token.slice(2)
      const separator = flag.indexOf('=')
      if (separator >= 0) {
        assignFlag(flag.slice(0, separator), flag.slice(separator + 1))
        continue
      }

      const next = tokens[index + 1]
      if (next && (!next.startsWith('-') || isNumericValueToken(next))) {
        assignFlag(flag, next)
        index += 1
        continue
      }

      assignFlag(flag, true)
      continue
    }

    if (token.startsWith('-') && token.length > 1) {
      const short = token.slice(1)
      if (short.length > 1) {
        for (const char of short) {
          assignFlag(char, true)
        }
        continue
      }

      const next = tokens[index + 1]
      if (next && (!next.startsWith('-') || isNumericValueToken(next))) {
        assignFlag(short, next)
        index += 1
        continue
      }

      assignFlag(short, true)
      continue
    }

    args.push(token)
  }

  return { args, flags }
}

export function isInteractive(io: IoStreams, flags: Record<string, string | boolean | readonly string[]>): boolean {
  const disabled = flags['no-interactive'] === true
  return io.stdin.isTTY === true && io.stdout.isTTY === true && !disabled
}

/* v8 ignore start */
export async function prompt(io: IoStreams, label: string): Promise<string> {
  const rl = createInterface({
    input: io.stdin,
    output: io.stdout,
  })

  try {
    return (await rl.question(label)).trim()
  } finally {
    rl.close()
  }
}

export async function confirm(io: IoStreams, label: string, defaultValue = false): Promise<boolean> {
  const suffix = defaultValue ? ' [Y/n] ' : ' [y/N] '
  const answer = (await prompt(io, `${label}${suffix}`)).toLowerCase()
  if (!answer) {
    return defaultValue
  }

  return answer === 'y' || answer === 'yes'
}
/* v8 ignore stop */

/* v8 ignore start */
export function normalizeChoice<TValue extends string>(
  value: string | undefined,
  allowed: readonly TValue[],
  label: string,
): TValue {
  const normalized = value?.trim().toLowerCase()
  if (normalized && allowed.includes(normalized as TValue)) {
    return normalized as TValue
  }

  throw new Error(`Unsupported ${label}: ${value ?? '(empty)'}. Expected one of ${allowed.join(', ')}.`)
}
/* v8 ignore stop */

/* v8 ignore start */
export async function promptChoice<TValue extends string>(
  io: IoStreams,
  label: string,
  allowed: readonly TValue[],
  defaultValue: TValue,
): Promise<TValue> {
  const answer = (await prompt(io, `${label} (${allowed.join('/')}) [${defaultValue}]: `)).trim().toLowerCase()
  if (!answer) {
    return defaultValue
  }

  return normalizeChoice(answer, allowed, label)
}
/* v8 ignore stop */

export function normalizeOptionalPackageName(value: string): string {
  const current = value.trim().toLowerCase()
  if (current === 'validate') {
    return 'validation'
  }

  if (current === 'form') {
    return 'forms'
  }

  return current
}

export function normalizeOptionalPackages(value: readonly string[] | undefined): readonly SupportedScaffoldOptionalPackage[] {
  if (!value || value.length === 0) {
    return []
  }

  const normalized = new Set<SupportedScaffoldOptionalPackage>()
  for (const raw of value) {
    const current = normalizeOptionalPackageName(raw)
    if (current === 'none') {
      continue
    }

    if (SUPPORTED_NEW_OPTIONAL_PACKAGES.includes(current as SupportedScaffoldOptionalPackage)) {
      normalized.add(current as SupportedScaffoldOptionalPackage)
      if (current === 'forms') {
        normalized.add('validation')
      }
      continue
    }

    throw new Error(
      `Unsupported optional package: ${raw}. Expected one of ${[...SUPPORTED_NEW_OPTIONAL_PACKAGES, 'none'].join(', ')}.`,
    )
  }

  return [...normalized].sort((left, right) => left.localeCompare(right))
}

/* v8 ignore start */
export async function promptOptionalPackages(io: IoStreams): Promise<readonly SupportedScaffoldOptionalPackage[]> {
  const answer = await prompt(io, `Optional packages (${[...SUPPORTED_NEW_OPTIONAL_PACKAGES, 'none'].join('/')}): `)
  return normalizeOptionalPackages(splitCsv(answer) ?? (answer ? [answer] : []))
}
/* v8 ignore stop */

export async function resolveNewProjectInput(
  io: IoStreams,
  input: RawParsedInput,
  prompts: {
    prompt(label: string): Promise<string>
    choose<TValue extends string>(label: string, allowed: readonly TValue[], defaultValue: TValue): Promise<TValue>
    optionalPackages(): Promise<readonly SupportedScaffoldOptionalPackage[]>
  } = {
    prompt: label => prompt(io, label),
    choose: (label, allowed, defaultValue) => promptChoice(io, label, allowed, defaultValue),
    optionalPackages: () => promptOptionalPackages(io),
  },
): Promise<NewProjectInput> {
  const flagProjectName = resolveStringFlag(input.flags, 'name')
  const positionalProjectName = input.args[0]?.trim()

  if (flagProjectName && positionalProjectName && flagProjectName !== positionalProjectName) {
    throw new Error('Conflicting project names. Use either the positional argument or --name, not both.')
  }

  const interactive = isInteractive(io, input.flags)
  const projectName = (flagProjectName ?? positionalProjectName)?.trim()
    || (interactive ? await prompts.prompt('Project name: ') : '')
  if (!projectName) {
    throw new Error(interactive ? 'Project creation cancelled.' : 'Missing required argument: Project name.')
  }

  const framework = resolveStringFlag(input.flags, 'framework')
    ? normalizeChoice(resolveStringFlag(input.flags, 'framework'), SUPPORTED_NEW_FRAMEWORKS, 'framework')
    : interactive
      ? await prompts.choose('Framework', SUPPORTED_NEW_FRAMEWORKS, 'nuxt')
      : 'nuxt'

  const databaseDriver = resolveStringFlag(input.flags, 'database')
    ? normalizeChoice(resolveStringFlag(input.flags, 'database'), SUPPORTED_NEW_DATABASE_DRIVERS, 'database driver')
    : interactive
      ? await prompts.choose('Database driver', SUPPORTED_NEW_DATABASE_DRIVERS, 'sqlite')
      : 'sqlite'

  const packageManager = resolveStringFlag(input.flags, 'package-manager')
    ? normalizeChoice(resolveStringFlag(input.flags, 'package-manager'), SUPPORTED_NEW_PACKAGE_MANAGERS, 'package manager')
    : interactive
      ? await prompts.choose('Package manager', SUPPORTED_NEW_PACKAGE_MANAGERS, 'bun')
      : 'bun'

  const requestedOptionalPackages = collectMultiStringFlag(input.flags, 'package')
  let optionalPackages: readonly SupportedScaffoldOptionalPackage[]
  if (requestedOptionalPackages) {
    const normalizedOptionalPackages: string[] = []
    for (const entry of requestedOptionalPackages) {
      normalizedOptionalPackages.push(...splitCsv(entry))
    }
    optionalPackages = normalizeOptionalPackages(normalizedOptionalPackages)
  } else if (interactive) {
    optionalPackages = await prompts.optionalPackages()
  } else {
    optionalPackages = []
  }

  const storageDefaultDisk = optionalPackages.includes('storage')
    ? (resolveStringFlag(input.flags, 'storage-default-disk')
        ? normalizeChoice(resolveStringFlag(input.flags, 'storage-default-disk'), SUPPORTED_NEW_STORAGE_DISKS, 'storage default disk')
        : interactive
          ? await prompts.choose('Default storage disk', SUPPORTED_NEW_STORAGE_DISKS, 'local')
          : 'local')
    : 'local'

  return {
    projectName,
    framework,
    databaseDriver,
    packageManager,
    storageDefaultDisk,
    optionalPackages,
  }
}

export async function ensureRequiredArg(
  io: IoStreams,
  input: RawParsedInput,
  index: number,
  label: string,
): Promise<string> {
  const value = input.args[index]?.trim()
  if (value) {
    return value
  }

  /* v8 ignore next 12 */
  if (!isInteractive(io, input.flags)) {
    throw new Error(`Missing required argument: ${label}.`)
  }

  const prompted = await prompt(io, `${label}: `)
  if (!prompted) {
    throw new Error(`Missing required argument: ${label}.`)
  }

  return prompted
}

export function resolveStringFlag(
  flags: Readonly<Record<string, CommandFlagValue>>,
  name: string,
  alias?: string,
): string | undefined {
  const value = flags[name] ?? (alias ? flags[alias] : undefined)
  if (Array.isArray(value)) {
    return value[value.length - 1]
  }

  if (typeof value === 'string') {
    return value
  }

  return undefined
}

export function collectMultiStringFlag(
  flags: Readonly<Record<string, CommandFlagValue>>,
  name: string,
  alias?: string,
): string[] | undefined {
  const value = flags[name] ?? (alias ? flags[alias] : undefined)
  if (Array.isArray(value)) {
    return value
      .map(entry => entry.trim())
      .filter(Boolean)
  }

  if (typeof value === 'string') {
    const normalized = value.trim()
    return normalized ? [normalized] : undefined
  }

  return undefined
}

export function resolveBooleanFlag(
  flags: Readonly<Record<string, CommandFlagValue>>,
  name: string,
  alias?: string,
): boolean {
  const value = flags[name] ?? (alias ? flags[alias] : undefined)
  if (Array.isArray(value)) {
    return value[value.length - 1] === 'true'
  }

  if (typeof value === 'string') {
    return value === 'true'
  }

  return value === true
}

export function parseNumberFlag(
  flags: Readonly<Record<string, CommandFlagValue>>,
  name: string,
  alias?: string,
): number | undefined {
  const raw = resolveStringFlag(flags, name, alias)
  if (typeof raw === 'undefined') {
    return undefined
  }

  if (!/^\d+$/.test(raw)) {
    throw new Error(`Flag "--${name}" must be a non-negative integer.`)
  }

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Flag "--${name}" must be a non-negative integer.`)
  }

  return parsed
}

export function splitCsv(value: string): string[]
export function splitCsv(value: string | undefined): string[] | undefined
export function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined
  }

  return value
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
}
