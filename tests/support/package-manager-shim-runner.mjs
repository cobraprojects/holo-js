import { accessSync, appendFileSync, constants, existsSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'
const DEPTH_VARIABLE = 'HOLO_PACKAGE_MANAGER_SHIM_DEPTH'
const WINDOWS_META_CHARS = /([()\][%!^"`<>&|;, *?])/g
const MAX_DEPTH = 8

function defaultIsFile(candidate, platform) {
  try {
    if (!statSync(candidate).isFile()) return false
    if (platform !== 'win32') accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function escapeWindowsCommand(command) {
  return command.replace(WINDOWS_META_CHARS, '^$1')
}

function escapeWindowsArgument(argument, doubleEscapeMetaChars) {
  let escaped = `${argument}`.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, '$1$1')
  escaped = `"${escaped}"`.replace(WINDOWS_META_CHARS, '^$1')
  return doubleEscapeMetaChars ? escaped.replace(WINDOWS_META_CHARS, '^$1') : escaped
}

export function buildWindowsBatchInvocation(file, args, comspec = 'cmd.exe') {
  const doubleEscapeMetaChars = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file)
  const commandLine = [
    escapeWindowsCommand(path.win32.normalize(file)),
    ...args.map(argument => escapeWindowsArgument(argument, doubleEscapeMetaChars)),
  ].join(' ')
  return { file: comspec, args: ['/d', '/s', '/c', `"${commandLine}"`], windowsVerbatimArguments: true }
}

function sameDirectory(flavor, left, right, platform) {
  const normalize = value => flavor.normalize(value).replace(/[\\/]+$/, '')
  return platform === 'win32'
    ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right)
}

export function resolveExecutable(name, searchPath, options = {}) {
  const platform = options.platform ?? process.platform
  const flavor = platform === 'win32' ? path.win32 : path.posix
  const isFile = options.isFile ?? (candidate => defaultIsFile(candidate, platform))
  const canonicalize = options.canonicalize ?? (value => value)
  const extensions = platform === 'win32'
    ? (options.pathext ?? process.env.PATHEXT ?? DEFAULT_PATHEXT).split(';').filter(Boolean)
    : ['']

  for (const directory of searchPath.split(flavor.delimiter)) {
    if (!directory) continue
    if (options.excludeDir && sameDirectory(flavor, canonicalize(directory), canonicalize(options.excludeDir), platform)) continue
    for (const extension of extensions) {
      const candidate = flavor.join(directory, `${name}${extension}`)
      if (isFile(candidate)) return candidate
    }
  }
  return undefined
}

function canonicalDirectory(directory) {
  try {
    return realpathSync(directory)
  } catch {
    return directory
  }
}

function childEnvironment(depth) {
  return { ...process.env, [DEPTH_VARIABLE]: String(depth + 1) }
}

function recordInstallRequest(shimRoot, env) {
  appendFileSync(path.join(shimRoot, 'install-requests.log'), `${realpathSync(process.cwd())}\n`)
  if (!existsSync('install-hook.cjs')) return 0
  const hook = spawnSync(process.execPath, ['install-hook.cjs'], { stdio: 'inherit', env })
  return hook.status ?? 1
}

function runRealBinary(realBinary, args, env) {
  const isBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(realBinary)
  const invocation = isBatch
    ? buildWindowsBatchInvocation(realBinary, args, process.env.ComSpec)
    : { file: realBinary, args, windowsVerbatimArguments: false }
  const child = spawn(invocation.file, invocation.args, {
    stdio: 'inherit',
    env,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  })
  child.on('error', error => {
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0))
  })
}

function main() {
  const [manager, ...args] = process.argv.slice(2)
  const shimRoot = path.dirname(fileURLToPath(import.meta.url))
  const depth = Number(process.env[DEPTH_VARIABLE] ?? 0)
  if (depth >= MAX_DEPTH) {
    process.stderr.write(`${manager}: package manager shim re-entered itself ${depth} times\n`)
    process.exit(1)
  }
  const env = childEnvironment(depth)

  if (args[0] === 'install') {
    process.exit(recordInstallRequest(shimRoot, env))
  }

  const realBinary = resolveExecutable(manager, process.env.PATH ?? '', {
    excludeDir: shimRoot,
    canonicalize: canonicalDirectory,
  })
  if (!realBinary) {
    process.stderr.write(`${manager} is not installed\n`)
    process.exit(127)
  }
  runRealBinary(realBinary, args, env)
}

function isEntryPoint() {
  if (!process.argv[1]) return false
  return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
}

if (isEntryPoint()) {
  main()
}
