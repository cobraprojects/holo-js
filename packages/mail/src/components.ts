export interface MailComponentSource {
  readonly html: string
  readonly text: string
}

export type MailComponentSlot = 'inline' | 'block'

export interface MailComponentBehavior {
  readonly slot: MailComponentSlot
  readonly defaults: Readonly<Record<string, string>>
  readonly urlAttributes: readonly string[]
}

const BUTTON_HTML = [
  '<table class="action" align="center" width="100%" cellpadding="0" cellspacing="0" role="presentation">',
  '<tr>',
  '<td align="center">',
  '<table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">',
  '<tr>',
  '<td align="center">',
  '<table border="0" cellpadding="0" cellspacing="0" role="presentation">',
  '<tr>',
  '<td>',
  '<a href="{{ url }}" class="button button-{{ color }}" target="_blank" rel="noopener">{!! slot !!}</a>',
  '</td>',
  '</tr>',
  '</table>',
  '</td>',
  '</tr>',
  '</table>',
  '</td>',
  '</tr>',
  '</table>',
].join('\n')

const PANEL_HTML = [
  '<table class="panel" width="100%" cellpadding="0" cellspacing="0" role="presentation">',
  '<tr>',
  '<td class="panel-content">',
  '<table width="100%" cellpadding="0" cellspacing="0" role="presentation">',
  '<tr>',
  '<td class="panel-item">',
  '{!! slot !!}',
  '</td>',
  '</tr>',
  '</table>',
  '</td>',
  '</tr>',
  '</table>',
].join('\n')

const TABLE_HTML = [
  '<div class="table">',
  '{!! slot !!}',
  '</div>',
].join('\n')

const SUBCOPY_HTML = [
  '<table class="subcopy" width="100%" cellpadding="0" cellspacing="0" role="presentation">',
  '<tr>',
  '<td>',
  '{!! slot !!}',
  '</td>',
  '</tr>',
  '</table>',
].join('\n')

const SLOT_TEXT = '{!! slot !!}'

export const BUILT_IN_MAIL_COMPONENTS: Readonly<Record<string, MailComponentSource>> = Object.freeze({
  button: { html: BUTTON_HTML, text: `${SLOT_TEXT}: {{ url }}` },
  panel: { html: PANEL_HTML, text: SLOT_TEXT },
  table: { html: TABLE_HTML, text: SLOT_TEXT },
  subcopy: { html: SUBCOPY_HTML, text: SLOT_TEXT },
})

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
  const behavior = Object.hasOwn(BUILT_IN_MAIL_COMPONENT_BEHAVIORS, name) ? BUILT_IN_MAIL_COMPONENT_BEHAVIORS[name] : undefined
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
