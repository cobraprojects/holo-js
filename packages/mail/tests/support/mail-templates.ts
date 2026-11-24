import { configureMailRuntime, normalizeMailConfig, type MailJsonObject } from '../../src'
import { compileMailRegistry, type CompiledMailRegistry, type MailRegistrySources } from '../../src/templates'

declare module '../../src/contracts-types' {
  interface HoloMailTemplateRegistry {
    readonly 'welcome': Record<string, never>
    readonly 'fixture': MailJsonObject
  }

  interface HoloMailThemeRegistry {
    readonly brand: true
    readonly receipt: true
  }
}

export function compileWithoutLayout(
  templates: Readonly<Record<string, string>>,
  components: MailRegistrySources['components'] = {},
): CompiledMailRegistry {
  return compileMailRegistry({
    templates,
    components,
    layouts: { html: '{!! body !!}', text: '{!! body !!}' },
    themes: { default: '' },
  })
}

export function configureFakeMailerWithTemplates(
  templates: Readonly<Record<string, string>>,
  components: MailRegistrySources['components'] = {},
): void {
  configureMailRuntime({
    config: normalizeMailConfig({
      default: 'fake',
      from: { email: 'noreply@example.com' },
      mailers: { fake: { driver: 'fake' } },
    }),
    environment: 'test',
    compiled: compileWithoutLayout(templates, components),
  })
}
