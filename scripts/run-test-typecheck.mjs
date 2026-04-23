import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const packagesRoot = resolve('packages')

async function main() {
  const packageDirs = await collectPackageDirsWithTests()
  const generatedConfigDirs = []

  try {
    for (const packageDir of packageDirs) {
      const configPaths = await resolveTestTsconfigs(packageDir, generatedConfigDirs)
      for (const configPath of configPaths) {
        await runTypecheck(configPath, packageDir)
      }
    }
  } finally {
    await Promise.all(generatedConfigDirs.map(path => rm(path, {
      recursive: true,
      force: true,
    })))
  }
}

async function collectPackageDirsWithTests() {
  const entries = await readdir(packagesRoot, { withFileTypes: true })
  const packageDirs = []

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const packageDir = join(packagesRoot, entry.name)
    if (!(await pathExists(join(packageDir, 'tests'))) || !(await pathExists(join(packageDir, 'tsconfig.json')))) {
      continue
    }

    packageDirs.push(packageDir)
  }

  return packageDirs.sort()
}

async function resolveTestTsconfigs(packageDir, generatedConfigDirs) {
  const configPaths = []
  const explicitMainConfigPath = join(packageDir, 'tsconfig.tests.json')

  if (await pathExists(explicitMainConfigPath)) {
    configPaths.push(explicitMainConfigPath)
  } else {
    configPaths.push(await createGeneratedMainTestConfig(packageDir, generatedConfigDirs))
  }

  const typeTestFiles = await collectTypeTestFiles(packageDir)
  for (const typeTestFile of typeTestFiles) {
    configPaths.push(await createGeneratedTypeTestConfig(packageDir, typeTestFile, generatedConfigDirs))
  }

  return configPaths
}

async function createGeneratedMainTestConfig(packageDir, generatedConfigDirs) {
  const generatedConfigDir = await mkdtemp(join(tmpdir(), 'holo-test-typecheck-'))
  generatedConfigDirs.push(generatedConfigDir)

  const generatedConfigPath = join(generatedConfigDir, 'tsconfig.json')
  const relativeExtendsPath = relative(generatedConfigDir, join(packageDir, 'tsconfig.json'))

  await writeFile(generatedConfigPath, JSON.stringify({
    extends: relativeExtendsPath,
    compilerOptions: {
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
    },
    include: [
      join(packageDir, 'src/**/*').replaceAll('\\', '/'),
      join(packageDir, 'tests/**/*.ts').replaceAll('\\', '/'),
    ],
    exclude: [
      join(packageDir, 'node_modules').replaceAll('\\', '/'),
      join(packageDir, 'dist').replaceAll('\\', '/'),
      join(packageDir, 'tests/**/*.type.test.ts').replaceAll('\\', '/'),
    ],
  }, null, 2))

  return generatedConfigPath
}

async function createGeneratedTypeTestConfig(packageDir, typeTestFile, generatedConfigDirs) {
  const generatedConfigDir = await mkdtemp(join(tmpdir(), 'holo-type-test-typecheck-'))
  generatedConfigDirs.push(generatedConfigDir)

  const generatedConfigPath = join(generatedConfigDir, 'tsconfig.json')
  const relativeExtendsPath = relative(generatedConfigDir, join(packageDir, 'tsconfig.json'))

  await writeFile(generatedConfigPath, JSON.stringify({
    extends: relativeExtendsPath,
    compilerOptions: {
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
    },
    include: [
      join(packageDir, 'src/**/*').replaceAll('\\', '/'),
      typeTestFile.replaceAll('\\', '/'),
    ],
    exclude: [
      join(packageDir, 'node_modules').replaceAll('\\', '/'),
      join(packageDir, 'dist').replaceAll('\\', '/'),
    ],
  }, null, 2))

  return generatedConfigPath
}

async function collectTypeTestFiles(packageDir) {
  const testsDir = join(packageDir, 'tests')
  const entries = await readdir(testsDir, {
    recursive: true,
    withFileTypes: true,
  })

  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.type.test.ts'))
    .map(entry => join(entry.parentPath, entry.name))
    .sort()
}

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function runTypecheck(configPath, packageDir) {
  return new Promise((resolvePromise, rejectPromise) => {
    const displayPath = relative(process.cwd(), packageDir) || packageDir
    const child = spawn('bunx', ['tsc', '-p', configPath, '--noEmit'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })

    child.on('exit', code => {
      if (code === 0) {
        resolvePromise()
        return
      }

      rejectPromise(new Error(`Test typecheck failed for ${displayPath}`))
    })

    child.on('error', rejectPromise)
  })
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
