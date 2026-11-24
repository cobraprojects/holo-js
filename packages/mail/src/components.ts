import { DEFAULT_MAIL_COMPONENTS, MAIL_COMPONENT_SLOT_TEXT } from './defaults'
import { MailError } from './errors'
import { findOwnEntry } from './own-entry'

export interface MailComponentSource {
  readonly html: string
  readonly text: string
}

export type MailComponentFiles = Partial<MailComponentSource>

export type MailComponentSlot = 'inline' | 'block'

export interface MailComponentBehavior {
  readonly slot: MailComponentSlot
  readonly defaults: Readonly<Record<string, string>>
  readonly urlAttributes: readonly string[]
}

const MAIL_COMPONENT_NAME_PATTERN = /^[a-z][\w-]*$/

function resolveAppMailComponent(name: string, files: MailComponentFiles): MailComponentSource {
  if (!MAIL_COMPONENT_NAME_PATTERN.test(name)) {
    throw new MailError(
      `[@holo-js/mail] "${name}" is not a Mail component name. Start it with a lowercase letter and use letters, digits, "-" and "_".`,
      'MAIL_COMPONENT_NAME_INVALID',
    )
  }

  const builtIn = findOwnEntry(DEFAULT_MAIL_COMPONENTS, name)
  const html = files.html ?? builtIn?.html
  if (html === undefined) {
    throw new MailError(
      `[@holo-js/mail] Mail component "${name}" has a text form but no HTML form. Add server/mail/components/${name}.html.`,
      'MAIL_COMPONENT_HTML_MISSING',
    )
  }

  return { html, text: files.text ?? builtIn?.text ?? MAIL_COMPONENT_SLOT_TEXT }
}

export function resolveMailComponentSources(
  appComponents: Readonly<Record<string, MailComponentFiles>>,
): Readonly<Record<string, MailComponentSource>> {
  return Object.freeze({
    ...DEFAULT_MAIL_COMPONENTS,
    ...Object.fromEntries(Object.entries(appComponents).map(([name, files]) => [name, resolveAppMailComponent(name, files)])),
  })
}

const DEFAULT_MAIL_COMPONENT_BEHAVIOR: MailComponentBehavior = Object.freeze({
  slot: 'block',
  defaults: Object.freeze({}),
  urlAttributes: Object.freeze([]),
})

const BUILT_IN_MAIL_COMPONENT_BEHAVIORS: Readonly<Record<string, MailComponentBehavior>> = Object.freeze({
  button: Object.freeze({
    slot: 'inline',
    defaults: Object.freeze({ color: 'primary' }),
    urlAttributes: Object.freeze(['url']),
  }),
})

export function resolveMailComponentBehavior(name: string): MailComponentBehavior {
  const behavior = findOwnEntry(BUILT_IN_MAIL_COMPONENT_BEHAVIORS, name)
  return behavior ?? DEFAULT_MAIL_COMPONENT_BEHAVIOR
}

export function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}
