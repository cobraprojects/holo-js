import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { removeStaleGeneratedConfigs } from './remove-stale-test-typecheck-configs.mjs'
import { runTypecheckJobs } from './typecheck-runner.mjs'

const packagesRoot = resolve('packages')
const generatedConfigsRootPrefix = resolve('.holo-test-typecheck-')

async function main() {
  const packageDirs = await collectPackageDirsWithTests()
  let generatedConfigsRootDir

  try {
    await removeStaleGeneratedConfigs(generatedConfigsRootPrefix)
    generatedConfigsRootDir = await mkdtemp(generatedConfigsRootPrefix)

    const jobs = []
    for (const packageDir of packageDirs) {
      const configPaths = await resolveTestTsconfigs(packageDir, generatedConfigsRootDir)
      for (const configPath of configPaths) {
        jobs.push({ name: testJobName(packageDir, configPath), configPath })
      }
    }

    await runTypecheckJobs(jobs, 'Test typecheck')
  } finally {
    if (generatedConfigsRootDir) {
      await rm(generatedConfigsRootDir, {
        recursive: true,
        force: true,
      })
    }
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

async function resolveTestTsconfigs(packageDir, generatedConfigsRootDir) {
  const configPaths = []
  const explicitMainConfigPath = join(packageDir, 'tsconfig.tests.json')

  if (await pathExists(explicitMainConfigPath)) {
    configPaths.push(explicitMainConfigPath)
  } else {
    configPaths.push(await createGeneratedMainTestConfig(packageDir, generatedConfigsRootDir))
  }

  const typeTestFiles = await collectTypeTestFiles(packageDir)
  if (typeTestFiles.length > 0) {
    configPaths.push(await createGeneratedTypeTestsBatchConfig(packageDir, typeTestFiles, generatedConfigsRootDir))
  }

  return configPaths
}

async function createGeneratedMainTestConfig(packageDir, generatedConfigsRootDir) {
  const generatedConfigDir = join(generatedConfigsRootDir, relative(packagesRoot, packageDir), 'main')
  await mkdir(generatedConfigDir, { recursive: true })
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

async function createGeneratedTypeTestsBatchConfig(packageDir, typeTestFiles, generatedConfigsRootDir) {
  const generatedConfigDir = join(generatedConfigsRootDir, relative(packagesRoot, packageDir), 'type-tests')
  await mkdir(generatedConfigDir, { recursive: true })
  const generatedConfigPath = join(generatedConfigDir, 'tsconfig.json')
  const relativeExtendsPath = relative(generatedConfigDir, join(packageDir, 'tsconfig.json'))

  await writeFile(generatedConfigPath, JSON.stringify({
    extends: relativeExtendsPath,
    compilerOptions: {
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
    },
    include: [
      join(packageDir, 'src/**/*').replaceAll('\\', '/'),
      ...typeTestFiles.map(typeTestFile => typeTestFile.replaceAll('\\', '/')),
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
    .map(entry => {
      const parentPath = entry.parentPath ?? dirname(entry.path) ?? testsDir
      return join(parentPath, entry.name)
    })
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

function testJobName(packageDir, configPath) {
  const packageName = relative(packagesRoot, packageDir)
  return configPath.endsWith(join('type-tests', 'tsconfig.json'))
    ? `${packageName} [type tests]`
    : `${packageName} [tests]`
}

const entrypoint = process.argv[1]
if (typeof entrypoint === 'string' && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
