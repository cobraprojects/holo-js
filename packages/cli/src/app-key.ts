import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export type AppKeyGenerateResult = {
  readonly envPath: string
  readonly generated: boolean
  readonly key?: string
}

const appKeyLinePattern = /^(\s*(?:export\s+)?APP_KEY\s*=\s*)(.*)$/

export function generateAppKey(): string {
  return randomBytes(32).toString('base64')
}

function isEmptyAppKeyValue(value: string): boolean {
  const normalized = value.trim()

  return normalized === '' || normalized === '""' || normalized === '\'\''
}

export function renderEnvWithAppKey(
  existingContents: string | undefined,
  appKey: string,
): { readonly contents?: string, readonly changed: boolean } {
  if (!existingContents) {
    return {
      contents: `APP_KEY=${appKey}\n`,
      changed: true,
    }
  }

  const lines = existingContents.replace(/\r\n/g, '\n').split('\n')
  const appKeyIndex = lines.findIndex(line => appKeyLinePattern.test(line))

  if (appKeyIndex === -1) {
    return {
      contents: `${existingContents.replace(/\r\n/g, '\n').replace(/\n*$/, '')}\nAPP_KEY=${appKey}\n`,
      changed: true,
    }
  }

  const appKeyLine = lines[appKeyIndex]!
  const match = appKeyLine.match(appKeyLinePattern)!
  const prefix = match[1]!
  const value = match[2]!

  if (!isEmptyAppKeyValue(value)) {
    return {
      contents: existingContents,
      changed: false,
    }
  }

  lines[appKeyIndex] = `${prefix}${appKey}`

  return {
    contents: `${lines.join('\n').replace(/\n*$/, '')}\n`,
    changed: true,
  }
}

export async function generateProjectAppKey(projectRoot: string): Promise<AppKeyGenerateResult> {
  const envPath = resolve(projectRoot, '.env')
  const existingContents = await readFile(envPath, 'utf8').catch(() => undefined)
  const key = generateAppKey()
  const nextEnv = renderEnvWithAppKey(existingContents, key)

  if (!nextEnv.changed || typeof nextEnv.contents !== 'string') {
    return {
      envPath,
      generated: false,
    }
  }

  await writeFile(envPath, nextEnv.contents, 'utf8')

  return {
    envPath,
    generated: true,
    key,
  }
}
